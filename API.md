# StaySync — API Reference Documentation

**Base URLs:**

- **Production (Render):** `https://staysync-ad96.onrender.com`
- **Local Development:** `http://localhost:4000`

---

## Response Headers Contract

All responses from `/api/hotels` include custom metadata headers:

| Header               | Type      | Description                                                                                                |
| -------------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| `X-Data-Source`      | `string`  | Origin of the response: `cache` (served directly from Redis) or `workflow` (orchestrated on this request). |
| `X-Cached`           | `boolean` | `true` if the returned inventory is persisted in Redis; `false` if caching failed.                         |
| `X-Degraded`         | `boolean` | `true` if at least one supplier failed and partial results were returned.                                  |
| `X-Failed-Suppliers` | `string`  | Comma-separated list of failed suppliers (e.g., `supplierA`). Omitted if all succeeded.                    |
| `X-City`             | `string`  | Percent-encoded normalized city query (e.g. `delhi` or `new%20delhi`).                                     |
| `X-Result-Count`     | `integer` | Number of hotel offers in the response array.                                                              |
| `X-Request-Id`       | `uuid`    | Unique trace ID generated per HTTP request for log correlation.                                            |

---

## 0. Root Service Information

Returns top-level metadata, deployment status, documentation links, and essential API endpoints.

- **Method:** `GET`
- **Path:** `/`

### Example Request

```bash
curl -i "https://staysync-ad96.onrender.com/"
```

### Example Response (`200 OK`)

```json
{
  "name": "StaySync",
  "description": "Hotel Offer Orchestrator API",
  "status": "operational",
  "deployment": "Render",
  "documentation": "https://github.com/KalidasMarndi/StaySync#readme",
  "endpoints": ["/health", "/health/live", "/health/ready", "/api/hotels?city=delhi"]
}
```

---

## 1. Search Hotels

Retrieves aggregated, deduplicated hotel offers for a target city, ordered ascending by price.

- **Method:** `GET`
- **Path:** `/api/hotels`

### Query Parameters

| Parameter  | Type     | Required | Constraints                                       | Description                                                             |
| ---------- | -------- | -------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| `city`     | `string` | **Yes**  | 1–100 chars, letters, digits, spaces, `.` `'` `-` | Target destination city. Normalization trims whitespace and lowercases. |
| `minPrice` | `number` | No       | Finite number `≥ 0`                               | Minimum room rate (inclusive).                                          |
| `maxPrice` | `number` | No       | Finite number `≥ 0`, `maxPrice ≥ minPrice`        | Maximum room rate (inclusive).                                          |

### Example 1: Full Aggregation (Workflow Execution)

#### Request

```bash
curl -i "https://staysync-ad96.onrender.com/api/hotels?city=delhi"
```

#### Response (`200 OK`)

```http
HTTP/2 200
content-type: application/json; charset=utf-8
x-city: delhi
x-data-source: workflow
x-cached: true
x-degraded: false
x-result-count: 11
x-request-id: 3c59a37e-6136-4d1a-85d7-13359d95cf12

[
  { "name": "Zostel", "price": 1800, "supplier": "Supplier B", "commissionPct": 7 },
  { "name": "Bloomrooms", "price": 3500, "supplier": "Supplier A", "commissionPct": 9 },
  { "name": "Lemon Tree", "price": 4200, "supplier": "Supplier A", "commissionPct": 8 },
  { "name": "Ibis New Delhi", "price": 4800, "supplier": "Supplier B", "commissionPct": 12 },
  { "name": "Holtin", "price": 5340, "supplier": "Supplier B", "commissionPct": 20 },
  { "name": "Radison", "price": 5900, "supplier": "Supplier A", "commissionPct": 13 },
  { "name": "Hyatt Regency", "price": 9000, "supplier": "Supplier B", "commissionPct": 15 },
  { "name": "ITC Maurya", "price": 11000, "supplier": "Supplier A", "commissionPct": 16 },
  { "name": "Taj Palace", "price": 11800, "supplier": "Supplier B", "commissionPct": 17 },
  { "name": "The Oberoi", "price": 15000, "supplier": "Supplier A", "commissionPct": 12 },
  { "name": "The Leela Palace", "price": 18000, "supplier": "Supplier A", "commissionPct": 14 }
]
```

---

### Example 2: Price-Filtered Search (Redis Lua Cache Hit)

#### Request

```bash
curl -i "https://staysync-ad96.onrender.com/api/hotels?city=delhi&minPrice=4000&maxPrice=6000"
```

#### Response (`200 OK`)

```http
HTTP/2 200
content-type: application/json; charset=utf-8
x-city: delhi
x-data-source: cache
x-cached: true
x-degraded: false
x-result-count: 3
x-request-id: e90b249a-525c-4ce1-ae28-8686bfbe0917

[
  { "name": "Lemon Tree", "price": 4200, "supplier": "Supplier A", "commissionPct": 8 },
  { "name": "Ibis New Delhi", "price": 4800, "supplier": "Supplier B", "commissionPct": 12 },
  { "name": "Holtin", "price": 5340, "supplier": "Supplier B", "commissionPct": 20 },
  { "name": "Radison", "price": 5900, "supplier": "Supplier A", "commissionPct": 13 }
]
```

---

### Error Responses

#### 400 Bad Request — Missing City Parameter

```bash
curl -i "https://staysync-ad96.onrender.com/api/hotels"
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid query parameters",
    "details": [
      {
        "field": "city",
        "message": "city is required"
      }
    ],
    "requestId": "94fd2b6a-9bcf-46d2-9ea5-55ff6d140e69"
  }
}
```

#### 400 Bad Request — Inverted Price Bounds (`minPrice > maxPrice`)

```bash
curl -i "https://staysync-ad96.onrender.com/api/hotels?city=delhi&minPrice=8000&maxPrice=3000"
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid query parameters",
    "details": [
      {
        "field": "minPrice",
        "message": "minPrice must not exceed maxPrice"
      }
    ],
    "requestId": "9814421d-7a63-4ce4-8149-a292dcf3519c"
  }
}
```

#### HTTP Status Code Mapping

| Status | Code                     | Cause                                                                                 |
| ------ | ------------------------ | ------------------------------------------------------------------------------------- |
| `200`  | —                        | Successful search (served from cache or workflow).                                    |
| `400`  | `VALIDATION_ERROR`       | Missing required parameters, negative numbers, or invalid characters in `city`.       |
| `502`  | `SUPPLIERS_UNAVAILABLE`  | All upstream suppliers failed after retries.                                          |
| `503`  | `DEPENDENCY_UNAVAILABLE` | Temporal frontend unreachable, or price-filtered request made while Redis is offline. |
| `504`  | `WORKFLOW_TIMEOUT`       | Workflow execution exceeded the 30-second timeout ceiling (e.g. no worker running).   |
| `500`  | `INTERNAL_ERROR`         | Unexpected unhandled server exception (sanitized in production).                      |

---

## 2. Health Monitoring Endpoints

### A. Deep Dependency Health Probe

- **Method:** `GET`
- **Path:** `/health`
- **Cache-Control:** `no-store`
- **Status Codes:** `200 OK` (healthy or degraded), `503 Service Unavailable` (unhealthy)

Runs concurrent active probes across Redis, Temporal, Worker, and upstream Suppliers with a 2-second timeout.

#### Example Request

```bash
curl -s https://staysync-ad96.onrender.com/health | jq
```

#### Example Response (`200 OK`)

```json
{
  "status": "healthy",
  "ready": true,
  "timestamp": "2026-11-22T10:42:49.850Z",
  "uptimeSeconds": 15,
  "services": {
    "api": {
      "status": "healthy"
    },
    "redis": {
      "status": "healthy",
      "latencyMs": 64
    },
    "temporal": {
      "status": "healthy",
      "latencyMs": 4
    },
    "worker": {
      "status": "healthy",
      "latencyMs": 5,
      "details": {
        "activePollers": 1,
        "lastPollSecondsAgo": 26
      }
    },
    "supplierA": {
      "status": "healthy",
      "latencyMs": 6
    },
    "supplierB": {
      "status": "healthy",
      "latencyMs": 7
    }
  }
}
```

---

### B. Liveness Probe

- **Method:** `GET`
- **Path:** `/health/live`
- **Purpose:** Kubernetes or container runtime liveness check. Checks only the Node.js event loop.
- **Status Code:** `200 OK`

#### Example Response

```json
{
  "status": "alive",
  "timestamp": "2026-11-22T10:42:40.727Z",
  "uptimeSeconds": 6
}
```

---

### C. Readiness Probe

- **Method:** `GET`
- **Path:** `/health/ready`
- **Purpose:** Evaluates whether this instance is capable of serving hotel queries (Redis is up OR Temporal + Worker are ready).
- **Status Codes:** `200 OK` (ready), `503 Service Unavailable` (not ready).

#### Example Response

```json
{
  "status": "ready",
  "timestamp": "2026-11-22T10:42:49.850Z",
  "services": {
    "redis": { "status": "healthy", "latencyMs": 64 },
    "temporal": { "status": "healthy", "latencyMs": 4 },
    "worker": { "status": "healthy", "latencyMs": 5 }
  }
}
```

---

## 3. Mock Upstream Supplier APIs

Simulates wholesale partner inventory feeds. Used internally by Temporal activities during workflow execution.

### A. Supplier A Inventory

- **Method:** `GET`
- **Path:** `/supplierA/hotels`
- **Query Parameters:** `city` (optional, defaults to `delhi`).

#### Example Request

```bash
curl -s "https://staysync-ad96.onrender.com/supplierA/hotels?city=delhi" | jq
```

#### Example Response

```json
[
  { "hotelId": "supA_1", "name": "Bloomrooms", "price": 3500, "city": "delhi", "commissionPct": 9 },
  { "hotelId": "supA_2", "name": "Lemon Tree", "price": 4200, "city": "delhi", "commissionPct": 8 },
  { "hotelId": "supA_3", "name": "Radison", "price": 5900, "city": "delhi", "commissionPct": 13 },
  {
    "hotelId": "supA_4",
    "name": "ITC Maurya",
    "price": 11000,
    "city": "delhi",
    "commissionPct": 16
  },
  {
    "hotelId": "supA_5",
    "name": "The Oberoi",
    "price": 15000,
    "city": "delhi",
    "commissionPct": 12
  },
  {
    "hotelId": "supA_6",
    "name": "The Leela Palace",
    "price": 18000,
    "city": "delhi",
    "commissionPct": 14
  }
]
```

---

### B. Supplier B Inventory

- **Method:** `GET`
- **Path:** `/supplierB/hotels`
- **Query Parameters:** `city` (optional, defaults to `delhi`).

#### Example Request

```bash
curl -s "https://staysync-ad96.onrender.com/supplierB/hotels?city=delhi" | jq
```

#### Example Response

```json
[
  { "hotelId": "supB_1", "name": "Zostel", "price": 1800, "city": "delhi", "commissionPct": 7 },
  { "hotelId": "supB_2", "name": "Lemon Tree", "price": 4200, "city": "delhi", "commissionPct": 8 },
  {
    "hotelId": "supB_3",
    "name": "Ibis New Delhi",
    "price": 4800,
    "city": "delhi",
    "commissionPct": 12
  },
  { "hotelId": "supB_4", "name": "Holtin", "price": 5340, "city": "delhi", "commissionPct": 20 },
  {
    "hotelId": "supB_5",
    "name": "Hyatt Regency",
    "price": 9000,
    "city": "delhi",
    "commissionPct": 15
  },
  {
    "hotelId": "supB_6",
    "name": "Taj Palace",
    "price": 11800,
    "city": "delhi",
    "commissionPct": 17
  }
]
```

---

## 4. Development Failure Simulation Endpoints

> [!WARNING]
> These endpoints are mounted **only** when `NODE_ENV=development` and `ENABLE_FAILURE_SIMULATION=true`. They are strictly disabled and return `404 Not Found` in production deployments.

| Method | Path                                      | Description                                                                       |
| ------ | ----------------------------------------- | --------------------------------------------------------------------------------- |
| `GET`  | `/dev/suppliers/availability`             | Returns current runtime availability status of Supplier A and B.                  |
| `PUT`  | `/dev/suppliers/:supplierId/availability` | Dynamically toggles supplier on/off (`{"enabled": false}`).                       |
| `GET`  | `/dev/workflows/hotel-offers?city={city}` | Directly triggers and returns raw Temporal workflow diagnostic execution payload. |
