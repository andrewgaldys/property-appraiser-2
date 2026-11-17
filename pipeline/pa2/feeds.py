"""Licensed listing feeds: pull what is on the market into pipeline/listings/ for the importer.

Each feed needs a licence in your own name and credentials read from the environment (never from a
file in the repo). Nothing here reads a listing site's web pages:

  resimplifi  Resimplifi Serve API (commercial listings, sale and lease, with suites)
              RESIMPLIFI_API_KEY
  trestle     an MLS's RESO Web API on Trestle (Cotality): the feed MIAMI REALTORS gives brokers
              TRESTLE_CLIENT_ID, TRESTLE_CLIENT_SECRET
  bridge      an MLS's RESO Web API on Bridge: the feed MIAMI REALTORS gives agents
              BRIDGE_SERVER_TOKEN, BRIDGE_DATASET
  spark       an MLS on Flexmls, through FBS's Spark API (BeachesMLS uses Flexmls)
              SPARK_ACCESS_TOKEN
  reso-<key>  any other MLS's RESO Web API: its address and token, one entry per MLS in RESO_FEEDS

Written against each provider's published API description (November 2026). The request and paging
logic is tested against local stand-ins for those APIs, not yet against the live services.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Callable

USER_AGENT = "pa2-listings/1"
MAX_PAGES = 5000  # a guard against a feed that never stops paging

# RESO property types that can sit on the parcels this map carries (no houses or condo units).
RESO_TYPES = ("CommercialSale", "CommercialLease", "ResidentialIncome", "Land", "BusinessOpportunity")
RESO_STATUSES = ("Active", "ActiveUnderContract")
# Asked for when the feed's metadata lists them (an unknown field in $select is an error on some feeds).
RESO_FIELDS = (
    "ListingKey", "ListingId", "StandardStatus", "MlsStatus", "PropertyType", "PropertySubType", "ListPrice",
    "UnparsedAddress", "StreetNumber", "StreetDirPrefix", "StreetName", "StreetSuffix", "StreetDirSuffix", "UnitNumber",
    "City", "PostalCode", "CountyOrParish", "ParcelNumber", "Latitude", "Longitude",
    "BuildingAreaTotal", "LotSizeAcres", "LotSizeSquareFeet", "NumberOfUnitsTotal", "CapRate", "NetOperatingIncome",
    "PublicRemarks", "ListOfficeName", "ListOfficePhone", "ListAgentFullName", "ListAgentDirectPhone", "ListAgentEmail",
    "ModificationTimestamp", "OnMarketDate", "ListingContractDate", "LeaseAmountFrequency",
    "InternetEntireListingDisplayYN", "InternetAddressDisplayYN",
)


class FeedError(RuntimeError):
    """A feed could not be read. `status` is the HTTP status when there was one."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


@dataclass
class Feed:
    """What one provider returned: rows the importer reads, and how the panel should name the source."""

    key: str
    rows: list[dict]
    name: str
    kind: str  # mls | vendor
    disclaimer: str = ""
    url: str = ""
    note: str = ""
    logo: str = ""  # an MLS's logo, which its display rules ask for beside its listings


Log = Callable[[str], None]


def setting(env: dict, key: str, default: str = "") -> str:
    """An optional setting from the environment. Empty counts as not given (an unset repository
    variable arrives as an empty string in a workflow)."""
    return (env.get(key) or "").strip() or default


# ------------------------------------------------------------------------------------------------
# HTTP
# ------------------------------------------------------------------------------------------------


def _where(url: str) -> str:
    """Host and path of a URL for messages: never the query string."""
    u = urllib.parse.urlsplit(url)
    return f"{u.netloc}{u.path}"


def _retry_after(headers) -> float | None:
    value = headers.get("Retry-After") if headers else None
    try:
        return max(1.0, min(float(value), 120.0)) if value else None
    except ValueError:
        return None


def http(url: str, *, headers: dict | None = None, data: bytes | None = None, timeout: float = 90, tries: int = 5,
         sleep: Callable[[float], None] = time.sleep) -> tuple[bytes, dict]:
    """GET (or POST when `data` is given). Waits and retries on 429 and 5xx; raises FeedError otherwise."""
    request = urllib.request.Request(url, data=data, headers={"Accept": "application/json", "User-Agent": USER_AGENT, **(headers or {})})
    for attempt in range(tries):
        last = attempt == tries - 1
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read(), {k.lower(): v for k, v in response.headers.items()}
        except urllib.error.HTTPError as err:
            if err.code in (429, 500, 502, 503, 504) and not last:
                sleep(_retry_after(err.headers) or min(60.0, 2.0 ** attempt * 2))
                continue
            detail = re.sub(r"\s+", " ", err.read(400).decode("utf-8", "replace")).strip()
            raise FeedError(f"HTTP {err.code} from {_where(url)}{f': {detail[:200]}' if detail else ''}", err.code) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
            if not last:
                sleep(min(30.0, 2.0 ** attempt))
                continue
            raise FeedError(f"{_where(url)} did not answer: {getattr(err, 'reason', err)}") from None
    raise FeedError(f"{_where(url)} did not answer")  # not reached


def http_json(url: str, **kwargs) -> tuple[object, dict]:
    body, headers = http(url, **kwargs)
    try:
        return json.loads(body.decode("utf-8")), headers
    except (ValueError, UnicodeDecodeError):
        raise FeedError(f"{_where(url)} did not return JSON") from None


def same_origin(link: str, base: str) -> str:
    """A feed's "next page" link, resolved against the API's address. A link to any other host is
    refused: the request carries the credentials, and they go only where they were issued for."""
    url = urllib.parse.urljoin(base if base.endswith("/") else base + "/", link)
    a, b = urllib.parse.urlsplit(url), urllib.parse.urlsplit(base)
    if (a.scheme, a.netloc) != (b.scheme, b.netloc):
        raise FeedError(f"the feed's next-page link points to another host ({a.netloc}): stopped")
    return url


# ------------------------------------------------------------------------------------------------
# Resimplifi Serve (https://serve.resimplifi.com/api/docs)
# ------------------------------------------------------------------------------------------------

_RESIMPLIFI_ON_MARKET = {"active": "Active", "reduced": "Active", "pending": "Pending"}
_RATE_TYPES = {
    "month": "per month", "year": "per year", "sf_month": "$/SF/mo", "sfmonth": "$/SF/mo", "sf_year": "$/SF/yr",
    "sfyear": "$/SF/yr", "ac_month": "$/AC/mo", "acmonth": "$/AC/mo", "ac_year": "$/AC/yr", "acyear": "$/AC/yr",
}


def _text(*values: object) -> str:
    return " ".join(str(v).strip() for v in values if v not in (None, "") and str(v).strip())


def resimplifi_rows(listing: dict) -> list[dict]:
    """One Resimplifi listing -> importer rows: a sale row, and a lease row per available suite.

    Only what the record states is carried over. A lease with no suites keeps its rate range but
    no rate basis, because the record has none at that level.
    """
    status = _RESIMPLIFI_ON_MARKET.get(str(listing.get("status") or "").lower())
    if not status:
        return []  # leased, sold, off_market, draft, private
    meta = listing.get("meta") or {}
    prop = listing.get("property") or {}
    org = listing.get("organization") or {}
    who = (listing.get("profiles") or [{}])[0] or {}
    point = (listing.get("location") or {}).get("coordinates") or [None, None]
    kinds = str(listing.get("type") or "").lower()
    suites = [s for s in (listing.get("suites") or []) if isinstance(s, dict) and s.get("available") is not False]
    for_sale = "sale" in kinds or (kinds in ("unset", "pending", "") and meta.get("price") is not None)
    for_lease = "lease" in kinds or (kinds in ("unset", "pending", "") and not for_sale and bool(suites or meta.get("min_lease_rate")))
    base = {
        "Parcel ID": meta.get("tax_parcel_id"),
        "Address": _text(prop.get("address"), prop.get("address_2")),
        "City": prop.get("city"), "ZIP": prop.get("zip_code") or prop.get("postal_code"), "County": prop.get("county"),
        "Latitude": prop.get("latitude") if prop.get("latitude") is not None else point[1],
        "Longitude": prop.get("longitude") if prop.get("longitude") is not None else point[0],
        "Status": status, "Use": ", ".join(str(t) for t in (listing.get("property_types") or [])[:2]),
        "Title": listing.get("name"), "Firm": org.get("name") or who.get("company"),
        "Agent": _text(who.get("first_name"), who.get("last_name")), "Phone": who.get("mobile") or who.get("office"),
        "Email": who.get("email"), "URL": listing.get("source_url"),
        "Listed": listing.get("created"), "Updated": listing.get("modified"),
    }
    key = str(listing.get("id") or listing.get("_id") or listing.get("tid") or "")
    remarks = meta.get("highlights") or meta.get("description")
    rows: list[dict] = []
    if for_sale:
        per_sf = meta.get("price") is None and meta.get("price_per_sf") is not None
        rows.append({
            **base, "Listing ID": f"{key}-sale", "Type": "For sale",
            "Price": meta.get("price_per_sf") if per_sf else meta.get("price"), "Basis": "$/SF" if per_sf else "",
            "SF": meta.get("building_sf"), "Acres": meta.get("acres"), "Units": meta.get("total_units"),
            "Cap Rate": meta.get("cap_rate"), "Notes": remarks,
        })
    if for_lease:
        for i, s in enumerate(suites):
            lo, hi = s.get("rate_min"), s.get("rate_max")
            rows.append({
                **base, "Listing ID": f"{key}-{s.get('id') or i}", "Type": "Sublease" if s.get("sublease") else "For lease",
                "Space": s.get("unit"), "Price": lo if lo is not None else hi, "Price Max": hi if lo is not None else None,
                "Basis": _RATE_TYPES.get(str(s.get("rate_type") or "").lower(), ""),
                "SF": s.get("max_available_sf") or s.get("min_available_sf"),
                "Min SF": s.get("min_available_sf") if s.get("max_available_sf") else None,
                "Acres": s.get("acres"), "Notes": s.get("description") or remarks,
            })
        if not suites:
            lo, hi = meta.get("min_lease_rate"), meta.get("max_lease_rate")
            rows.append({
                **base, "Listing ID": f"{key}-lease", "Type": "For lease",
                "Price": lo if lo is not None else hi, "Price Max": hi if lo is not None else None,
                "SF": meta.get("max_available_sf") or meta.get("min_available_sf"),
                "Min SF": meta.get("min_available_sf") if meta.get("max_available_sf") else None,
                "Acres": meta.get("acres") if not meta.get("building_sf") else None, "Notes": remarks,
            })
    return [{k: v for k, v in r.items() if v not in (None, "")} for r in rows]


def fetch_resimplifi(env: dict, boxes: list[tuple[str, tuple[float, float, float, float]]], log: Log, *, sleep=time.sleep) -> Feed:
    """Every on-market listing inside the map's counties, one bounding box per county."""
    key = env["RESIMPLIFI_API_KEY"]
    base = setting(env, "RESIMPLIFI_BASE", "https://serve.resimplifi.com").rstrip("/")
    limit = setting(env, "RESIMPLIFI_PAGE", "100")
    found: dict[str, dict] = {}
    for label, (west, south, east, north) in boxes:
        query = {"west": west, "south": south, "east": east, "north": north, "statuses": "active,pending,reduced", "limit": limit}
        url: str | None = f"{base}/api/v1/listings/bbox?{urllib.parse.urlencode(query)}"
        pages, before = 0, len(found)
        while url:
            try:
                doc, _ = http_json(url, headers={"x-api-key": key}, sleep=sleep)
            except FeedError as err:
                if err.status == 402:
                    raise FeedError("Resimplifi answered 402 (payment required): the trial or plan does not cover this request", 402) from None
                if err.status in (401, 403):
                    raise FeedError(f"Resimplifi refused the API key (HTTP {err.status})", err.status) from None
                raise
            if not isinstance(doc, dict) or not isinstance(doc.get("listings"), list):
                raise FeedError("Resimplifi's answer has no 'listings' list: its API may have changed")
            for item in doc["listings"]:
                if isinstance(item, dict):
                    found[str(item.get("id") or item.get("_id") or len(found))] = item
            pages += 1
            if pages >= MAX_PAGES:
                raise FeedError("Resimplifi kept paging past the safety limit: stopped")
            url = same_origin(doc["nextUrl"], base) if doc.get("nextUrl") else None
        log(f"  resimplifi · {label}: {len(found) - before:,} new listings in {pages} page{'s' if pages != 1 else ''}")
    rows = [row for listing in found.values() for row in resimplifi_rows(listing)]
    return Feed(
        key="resimplifi", rows=rows, kind="vendor", name=setting(env, "RESIMPLIFI_SOURCE_NAME", "Resimplifi"),
        disclaimer=setting(env, "RESIMPLIFI_DISCLAIMER"), url="https://resimplifi.com",
        note=f"{len(found):,} listings in the feed, {len(rows):,} offerings on the market",
    )


# ------------------------------------------------------------------------------------------------
# RESO Web API: any MLS (Trestle, Bridge, Spark, or another platform's address and token)
# ------------------------------------------------------------------------------------------------

# Property types this map's parcels can carry, by the words in them: every MLS names its own
# ("CommercialSale", "Commercial/Industrial", "Income", "Vacant Land", "Business Opportunity").
_KEEP_TYPE = re.compile(r"commercial|industrial|income|business|office|retail|warehouse|multi|investment|mixed|hotel|motel|special|land|lot|acreage|duplex|triplex|quadplex|fourplex")
# Names that only ever mean a home, a home rental or a condo unit.
_HOME_TYPE = re.compile(r"^(residential|residentiallease|residentialrental|rental|singlefamily(residence|detached)?|condo(minium)?|townho(use|me)s?|villa|mobilehome|manufactured(home|inpark)?|cooperative|coop)$")
_ON_MARKET = {"active", "activeundercontract"}


def _norm(value: object) -> str:
    return re.sub(r"[^a-z]", "", str(value or "").lower())


def map_type(value: object) -> bool:
    """A property type the map can show, whatever the MLS calls it (homes and condo units are not)."""
    kind = _norm(value)
    return bool(kind and _KEEP_TYPE.search(kind) and not _HOME_TYPE.match(kind))


@dataclass
class ResoSource:
    """One MLS's RESO Web API: where its Property resource is and how to ask it."""

    key: str  # the feed's file: feed_<key>.json
    resource: str  # the Property resource URL
    headers: dict
    page: int  # records per request the feed allows
    skip_limit: int | None = None  # how far $skip may go (Bridge: 10,000); None = no limit
    name: str = "MLS feed"
    disclaimer: str = ""
    url: str = ""
    logo: str = ""
    types: tuple[str, ...] | None = None  # exact PropertyType values; None = by the words (map_type)
    statuses: tuple[str, ...] | None = None  # exact StandardStatus values; None = active, active under contract
    extra_filter: str = ""  # added with "and" (MLS Grid asks for OriginatingSystemName, for one)


def _attrs(text: str) -> dict[str, str]:
    return dict(re.findall(r'([\w:.]+)="([^"]*)"', text))


def _property_block(xml: str) -> str:
    m = re.search(r'<EntityType\b[^>]*\bName="Property"[^>]*>(.*?)</EntityType>', xml, re.S)
    return m.group(1) if m else ""


def metadata_fields(xml: str) -> set[str]:
    """Field names of the Property resource in a RESO $metadata document."""
    return {a["Name"] for t in re.findall(r"<(?:Navigation)?Property\b([^>]*)/?>", _property_block(xml)) if "Name" in (a := _attrs(t))}


def metadata_members(xml: str, field: str) -> list[str]:
    """The values a lookup field (PropertyType, StandardStatus) may take, when the metadata declares them."""
    for t in re.findall(r"<Property\b([^>]*)/?>", _property_block(xml)):
        a = _attrs(t)
        if a.get("Name") != field:
            continue
        type_name = re.sub(r"^Collection\((.*)\)$", r"\1", a.get("Type", ""))
        if not type_name or type_name.startswith("Edm."):
            return []
        enum = re.search(rf'<EnumType\b[^>]*\bName="{re.escape(type_name.rsplit(".", 1)[-1])}"[^>]*>(.*?)</EnumType>', xml, re.S)
        return [m for m in re.findall(r'<Member\b[^>]*\bName="([^"]+)"', enum.group(1))] if enum else []
    return []


def reso_filter(statuses: tuple[str, ...], types: tuple[str, ...] | None, spaced: bool = False, extra: str = "") -> str:
    """StandardStatus and PropertyType as an OData filter using only eq / or / and (every feed has those)."""
    def words(value: str) -> str:
        return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", value) if spaced else value

    def any_of(field: str, values: tuple[str, ...]) -> str:
        return "(" + " or ".join(f"{field} eq '{words(v).replace(chr(39), chr(39) * 2)}'" for v in values) + ")"

    parts = [any_of("StandardStatus", statuses)]
    if types:
        parts.append(any_of("PropertyType", types))
    if extra:
        parts.append(f"({extra})")
    return " and ".join(parts)


def _wanted(record: dict, types: tuple[str, ...] | None) -> bool:
    """Kept after download: a type the map can show, and not withheld from internet display."""
    if record.get("InternetEntireListingDisplayYN") is False or record.get("InternetAddressDisplayYN") is False:
        return False
    if types is not None:
        return _norm(record.get("PropertyType")) in {_norm(t) for t in types}
    return map_type(record.get("PropertyType"))


def _reso_pages(first_url: str, base: str, headers: dict, page: int, skip_limit: int | None, sleep) -> list[dict]:
    """Follow @odata.nextLink where the feed gives one, else step $skip until a short page."""
    out: list[dict] = []
    url: str | None = first_url
    pages = 0
    while url:
        doc, _ = http_json(url, headers=headers, sleep=sleep)
        values = doc.get("value") if isinstance(doc, dict) else None
        if not isinstance(values, list):
            raise FeedError(f"{_where(url)} returned no 'value' list")
        out += [v for v in values if isinstance(v, dict)]
        pages += 1
        if pages >= MAX_PAGES:
            raise FeedError("the MLS feed kept paging past the safety limit: stopped")
        nxt = doc.get("@odata.nextLink")
        if nxt:
            url = same_origin(nxt, base)
        elif len(values) >= page:
            if skip_limit is not None and len(out) >= skip_limit:
                raise FeedError(
                    f"more than {skip_limit:,} listings match and this feed pages no further with $skip: "
                    "narrow the property types, or ask the MLS to allow replication"
                )
            parts = urllib.parse.urlsplit(first_url)
            query = dict(urllib.parse.parse_qsl(parts.query))
            query["$skip"] = str(len(out))
            url = urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query, quote_via=urllib.parse.quote)))
        else:
            url = None
    return out


def lookup_values(base: str, headers: dict, field: str, *, sleep=time.sleep) -> list[str]:
    """Values of a string lookup field from the feed's Lookup resource (RESO Data Dictionary 2.0),
    for MLSs whose metadata types PropertyType as plain text. [] when the feed has no Lookup resource."""
    query = urllib.parse.urlencode({"$filter": f"LookupName eq '{field}'", "$top": "200"}, quote_via=urllib.parse.quote)
    try:
        doc, _ = http_json(f"{base}/Lookup?{query}", headers=headers, sleep=sleep, tries=2)
    except FeedError:
        return []
    values = doc.get("value") if isinstance(doc, dict) else None
    return [str(v["LookupValue"]) for v in values or [] if isinstance(v, dict) and v.get("LookupValue")]


def _spellings(values: tuple[str, ...]) -> tuple[str, ...]:
    """'ActiveUnderContract' and 'Active Under Contract': for a text field, either may be the MLS's."""
    out = list(values)
    for v in values:
        spaced = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", v)
        if spaced not in out:
            out.append(spaced)
    return tuple(out)


def fetch_reso(src: ResoSource, log: Log, *, sleep=time.sleep) -> Feed:
    """Active listings of the map's property types from one MLS. Its metadata (or its Lookup
    resource) says what it calls its property types and statuses, so the filter can name them
    exactly. When neither says, every active listing is fetched and sorted here by its type's words:
    slower, but a type the MLS spells its own way is never missed."""
    base = src.resource.rsplit("/", 1)[0]
    select, types, statuses = "", src.types, src.statuses
    enum_statuses = False
    try:
        raw, _ = http(f"{base}/$metadata", headers={**src.headers, "Accept": "application/xml"}, sleep=sleep)
        xml = raw.decode("utf-8", "replace")
        chosen = [f for f in RESO_FIELDS if f in metadata_fields(xml)]
        if len(chosen) >= 6:
            select = ",".join(chosen)
        if types is None:
            members = metadata_members(xml, "PropertyType") or lookup_values(base, src.headers, "PropertyType", sleep=sleep)
            types = tuple(m for m in members if map_type(m)) or None
        if statuses is None:
            members = metadata_members(xml, "StandardStatus")
            enum_statuses = bool(members)
            members = members or lookup_values(base, src.headers, "StandardStatus", sleep=sleep)
            statuses = tuple(m for m in members if _norm(m) in _ON_MARKET) or None
    except FeedError as err:
        log(f"  {src.key}: no metadata ({err}); asking for every field")
    if types:
        log(f"  {src.key}: property types {', '.join(types)}")
    else:
        log(f"  {src.key}: the feed does not list its property types; fetching every active listing and keeping the map's types")

    def url_for(filter_text: str) -> str:
        query = {"$filter": filter_text, "$top": str(src.page)}
        if select:
            query["$select"] = select
        return f"{src.resource}?{urllib.parse.urlencode(query, quote_via=urllib.parse.quote)}"

    # Statuses the feed declared are used as they are; otherwise both spellings, which a text field accepts.
    st = statuses if (statuses and (enum_statuses or src.statuses)) else _spellings(statuses or RESO_STATUSES)
    attempts = [reso_filter(st, types, extra=src.extra_filter)] if types else []
    attempts.append(reso_filter(st, None, extra=src.extra_filter))
    records: list[dict] = []
    for n, filter_text in enumerate(attempts):
        try:
            records = _reso_pages(url_for(filter_text), base, src.headers, src.page, src.skip_limit, sleep)
            if records:
                break
        except FeedError as err:
            if err.status != 400 or n == len(attempts) - 1:
                raise
    kept = [r for r in records if _wanted(r, src.types)]  # exact types when set, else the map's rule
    for r in kept:
        # In an MLS the property type says sale or lease: a lease or rental type is a lease, any other
        # type ("Income", "Vacant Land", "Commercial/Industrial") is a listing for sale.
        r.setdefault("TransactionType", "For lease" if re.search(r"lease|rent", _norm(r.get("PropertyType"))) else "For sale")
    log(f"  {src.key}: {len(records):,} records from the feed, {len(kept):,} of property types the map shows")
    return Feed(key=src.key, rows=kept, kind="mls", name=src.name, disclaimer=src.disclaimer, url=src.url, logo=src.logo,
                note=f"{len(kept):,} listings on the market")


def _naming(env: dict, prefix: str, default: str) -> dict:
    """How the panel names an MLS, and the notice and logo its rules ask for (PREFIX_SOURCE_NAME...)."""
    return {
        "name": setting(env, f"{prefix}_SOURCE_NAME", default), "disclaimer": setting(env, f"{prefix}_DISCLAIMER"),
        "url": setting(env, f"{prefix}_SOURCE_URL"), "logo": setting(env, f"{prefix}_LOGO_URL"),
    }


def _list(env: dict, key: str) -> tuple[str, ...] | None:
    values = tuple(v.strip() for v in setting(env, key).split(",") if v.strip())
    return values or None


def client_credentials(token_url: str, client_id: str, client_secret: str, scope: str, label: str, *, sleep=time.sleep) -> str:
    """An OAuth2 client-credentials access token."""
    form = {"client_id": client_id, "client_secret": client_secret, "grant_type": "client_credentials"}
    if scope:
        form["scope"] = scope
    try:
        doc, _ = http_json(token_url, data=urllib.parse.urlencode(form).encode(),
                           headers={"Content-Type": "application/x-www-form-urlencoded"}, sleep=sleep)
    except FeedError as err:
        raise FeedError(f"{label} did not issue a token ({err})", err.status) from None
    token = doc.get("access_token") if isinstance(doc, dict) else None
    if not token:
        raise FeedError(f"{label}'s token answer has no access_token")
    return str(token)


def fetch_trestle(env: dict, log: Log, *, sleep=time.sleep) -> Feed:
    """Trestle: an OAuth2 client-credentials token, then /odata/Property, 1,000 records a page."""
    base = setting(env, "TRESTLE_BASE", "https://api.cotality.com/trestle").rstrip("/")
    token = client_credentials(f"{base}/oidc/connect/token", env["TRESTLE_CLIENT_ID"], env["TRESTLE_CLIENT_SECRET"], "api", "Trestle", sleep=sleep)
    return fetch_reso(ResoSource("trestle", f"{base}/odata/Property", {"Authorization": f"Bearer {token}"}, page=1000,
                                 types=_list(env, "MLS_PROPERTY_TYPES"), statuses=_list(env, "MLS_STATUSES"),
                                 **_naming(env, "MLS", "MLS feed")), log, sleep=sleep)


def fetch_bridge(env: dict, log: Log, *, sleep=time.sleep) -> Feed:
    """Bridge: the server token as a bearer header, /OData/<dataset>/Property, 200 records a page (10,000 at most with $skip)."""
    base = setting(env, "BRIDGE_BASE", "https://api.bridgedataoutput.com/api/v2").rstrip("/")
    dataset = urllib.parse.quote(env["BRIDGE_DATASET"], safe="")
    return fetch_reso(ResoSource("bridge", f"{base}/OData/{dataset}/Property", {"Authorization": f"Bearer {env['BRIDGE_SERVER_TOKEN']}"},
                                 page=200, skip_limit=10_000, types=_list(env, "MLS_PROPERTY_TYPES"), statuses=_list(env, "MLS_STATUSES"),
                                 **_naming(env, "MLS", "MLS feed")), log, sleep=sleep)


def fetch_spark(env: dict, log: Log, *, sleep=time.sleep) -> Feed:
    """Spark (Flexmls): a non-expiring bearer token. 25 records a request, or 1,000 on the replication
    host when the key has the replication role (SPARK_REPLICATION=on)."""
    replication = setting(env, "SPARK_REPLICATION").lower() in ("1", "on", "true", "yes")
    default = "https://replication.sparkapi.com/Reso/OData" if replication else "https://sparkapi.com/Reso/OData"
    base = setting(env, "SPARK_BASE", default).rstrip("/")
    return fetch_reso(ResoSource("spark", f"{base}/Property", {"Authorization": f"Bearer {env['SPARK_ACCESS_TOKEN']}"},
                                 page=1000 if replication else 25, types=_list(env, "SPARK_PROPERTY_TYPES"),
                                 statuses=_list(env, "SPARK_STATUSES"), **_naming(env, "SPARK", "MLS feed")), log, sleep=sleep)


def custom_feeds(env: dict) -> dict[str, dict]:
    """RESO_FEEDS: a JSON list, one object per MLS, for any RESO Web API not named above:
    {"key": "irc", "name": "Indian River County MLS", "url": "https://.../Property", "token": "...",
     "page": 100, "disclaimer": "...", "logo": "https://...", "filter": "OriginatingSystemName eq 'x'"}
    or, instead of "token": "token_url", "client_id", "client_secret" (and "scope")."""
    raw = setting(env, "RESO_FEEDS")
    if not raw:
        return {}
    try:
        items = json.loads(raw)
    except ValueError:
        raise FeedError("RESO_FEEDS is not valid JSON") from None
    if isinstance(items, dict):
        items = [items]
    if not isinstance(items, list) or not all(isinstance(i, dict) for i in items):
        raise FeedError("RESO_FEEDS must be a list of objects")
    out: dict[str, dict] = {}
    for n, item in enumerate(items, start=1):
        key = re.sub(r"[^a-z0-9]+", "-", str(item.get("key") or f"mls{n}").lower()).strip("-")[:24] or f"mls{n}"
        out[f"reso-{key}"] = item
    return out


def _custom_source(name: str, item: dict, sleep) -> ResoSource:
    url = str(item.get("url") or "")
    if not re.match(r"^https://[^\s]+/Property$", url, re.I):
        raise FeedError(f"{name}: 'url' must be the https address of the feed's Property resource (ending in /Property)")
    if item.get("token"):
        token = str(item["token"])
    elif item.get("token_url") and item.get("client_id") and item.get("client_secret"):
        token = client_credentials(str(item["token_url"]), str(item["client_id"]), str(item["client_secret"]),
                                   str(item.get("scope") or ""), name, sleep=sleep)
    else:
        raise FeedError(f"{name}: give a 'token', or 'token_url' with 'client_id' and 'client_secret'")

    def tup(v: object) -> tuple[str, ...] | None:
        values = tuple(str(x).strip() for x in (v if isinstance(v, list) else str(v or "").split(",")) if str(x).strip())
        return values or None

    page = int(item.get("page") or 100)
    return ResoSource(
        name.replace("reso-", "", 1), url, {"Authorization": f"Bearer {token}"}, page=max(1, min(page, 5000)),
        skip_limit=int(item["skip_limit"]) if item.get("skip_limit") else None,
        name=str(item.get("name") or "MLS feed"), disclaimer=str(item.get("disclaimer") or ""),
        url=str(item.get("source_url") or ""), logo=str(item.get("logo") or ""),
        types=tup(item.get("types")), statuses=tup(item.get("statuses")), extra_filter=str(item.get("filter") or ""),
    )


# ------------------------------------------------------------------------------------------------
# Which feeds are set up, and writing their files
# ------------------------------------------------------------------------------------------------

REQUIRES = {
    "resimplifi": ("RESIMPLIFI_API_KEY",),
    "trestle": ("TRESTLE_CLIENT_ID", "TRESTLE_CLIENT_SECRET"),
    "bridge": ("BRIDGE_SERVER_TOKEN", "BRIDGE_DATASET"),
    "spark": ("SPARK_ACCESS_TOKEN",),
}


def configured(env: dict) -> list[str]:
    """Feeds whose credentials are present in the environment (RESO_FEEDS entries included)."""
    named = [name for name, needs in REQUIRES.items() if all(setting(env, k) for k in needs)]
    try:
        return named + list(custom_feeds(env))
    except FeedError:
        return named  # reported by --check and by the fetch itself


def county_boxes(data_dir: Path) -> list[tuple[str, tuple[float, float, float, float]]]:
    """(county name, west/south/east/north) for each county in the published bundle."""
    manifest = json.loads((data_dir / "manifest.json").read_text(encoding="utf-8"))
    boxes = [(str(c["name"]), tuple(c["bbox"])) for c in manifest.get("counties", []) if c.get("bbox")]
    return boxes or [("all", tuple(manifest["bounds"]))]


def fetch(name: str, env: dict, data_dir: Path, log: Log, *, sleep=time.sleep) -> Feed:
    if name == "resimplifi":
        return fetch_resimplifi(env, county_boxes(data_dir), log, sleep=sleep)
    if name == "trestle":
        return fetch_trestle(env, log, sleep=sleep)
    if name == "bridge":
        return fetch_bridge(env, log, sleep=sleep)
    if name == "spark":
        return fetch_spark(env, log, sleep=sleep)
    custom = custom_feeds(env)
    if name in custom:
        return fetch_reso(_custom_source(name, custom[name], sleep), log, sleep=sleep)
    raise FeedError(f"unknown feed '{name}'")


def write_feed(feed: Feed, folder: Path, today: date | None = None) -> Path:
    """Write feed_<key>.json and its .meta.json. The data file is swapped in whole, so a failed run
    never leaves half a feed behind."""
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"feed_{feed.key}.json"
    tmp = path.with_suffix(".json.part")
    tmp.write_text(json.dumps({"value": feed.rows}, ensure_ascii=False), encoding="utf-8")
    meta = {"name": feed.name, "kind": feed.kind, "as_of": (today or date.today()).isoformat()}
    for k in ("disclaimer", "url", "note", "logo"):
        if getattr(feed, k):
            meta[k] = getattr(feed, k)
    path.with_name(path.name + ".meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)
    return path
