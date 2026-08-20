import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, BatchGetCommand, BatchWriteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import * as OTPAuth from 'otpauth'

const sm = new SecretsManagerClient()
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient())
const TABLE = process.env.REVENUE_TABLE
const SECRET_ARN = process.env.PROSPER_SECRET_ARN
// Sum all site domains (wafflegame.net, puzzlist.com, giffle.com, etc.)

const PROSPER_HEADERS = {
  'content-type': 'application/json',
  Referer: 'https://prosper.venatus.com/',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
}

let cachedCredentials = null
let prosperJwt = null
let jwtExpiry = 0

// ── Helpers ───────────────────────────────────────────

function toDateStr(d) {
  return d.toISOString().split('T')[0]
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return toDateStr(d)
}

function dateRange(startDate, endDate) {
  const dates = []
  const current = new Date(startDate + 'T12:00:00Z')
  const end = new Date(endDate + 'T12:00:00Z')
  while (current <= end) {
    dates.push(toDateStr(current))
    current.setUTCDate(current.getUTCDate() + 1)
  }
  return dates
}

async function getCredentials() {
  if (cachedCredentials) return cachedCredentials
  const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }))
  cachedCredentials = JSON.parse(SecretString)
  return cachedCredentials
}

async function loginToProsper() {
  if (prosperJwt && Date.now() < jwtExpiry) return prosperJwt

  const { email, password, otpSecret } = await getCredentials()
  const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: otpSecret })
  const token = totp.generate()

  const resp = await fetch('https://prosper-api.venatusmedia.com/login', {
    method: 'POST',
    headers: PROSPER_HEADERS,
    body: JSON.stringify({ email, password, '2fa_code': token }),
  })

  if (!resp.ok) throw new Error(`Prosper login failed: ${resp.status}`)
  const json = await resp.json()
  prosperJwt = json.data.jwt
  jwtExpiry = Date.now() + 55 * 60 * 1000
  return prosperJwt
}

// ── Prosper API: bulk fetch with daily granularity ────

async function fetchRevenueRange(startDate, endDate) {
  const jwt = await loginToProsper()
  const startTime = `${startDate}T00:00:00.000Z`
  const endTime = `${endDate}T23:59:59.999Z`
  const url = `https://prosper-api.venatusmedia.com/reports/impression?fields=time%7Csite_domain&filter[start_time]=${startTime}&filter[end_time]=${endTime}&granularity=daily&page[limit]=5000&page[offset]=0`

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      ...PROSPER_HEADERS,
      authorization: `Bearer ${jwt}`,
      accept: 'application/json, text/plain, */*',
      'content-type': 'multipart/form-data',
    },
  })

  if (!resp.ok) throw new Error(`Prosper API error: ${resp.status}`)
  const { data } = await resp.json()

  // Group by date, sum all sites
  const byDate = {}
  if (data) {
    for (const row of data) {
      const date = row.time?.split('T')[0]
      if (!date) continue
      if (!byDate[date]) byDate[date] = { revenue: 0, impressions: 0 }
      byDate[date].revenue += row.publisher_revenue || 0
      byDate[date].impressions += row.impressions || 0
    }
    // Round revenue
    for (const d of Object.values(byDate)) {
      d.revenue = Math.round(d.revenue * 100) / 100
    }
  }

  return byDate
}

// ── Cache layer ───────────────────────────────────────

async function getCachedDates(dates) {
  const results = {}
  // BatchGet supports max 100 keys at a time
  for (let i = 0; i < dates.length; i += 100) {
    const batch = dates.slice(i, i + 100)
    const { Responses } = await ddb.send(new BatchGetCommand({
      RequestItems: {
        [TABLE]: {
          Keys: batch.map(d => ({ pk: 'REVENUE', sk: d })),
        },
      },
    }))
    for (const item of (Responses?.[TABLE] || [])) {
      results[item.sk] = { revenue: item.revenue, impressions: item.impressions }
    }
  }
  return results
}

async function cacheDates(dateMap) {
  const today = toDateStr(new Date())
  const entries = Object.entries(dateMap)
  // BatchWrite supports max 25 items at a time
  for (let i = 0; i < entries.length; i += 25) {
    const batch = entries.slice(i, i + 25)
    await ddb.send(new BatchWriteCommand({
      RequestItems: {
        [TABLE]: batch.map(([date, data]) => ({
          PutRequest: {
            Item: {
              pk: 'REVENUE',
              sk: date,
              ...data,
              cachedAt: Date.now(),
              // Today/yesterday: 1h. Older: 7 days. Very old (>30d): 30 days.
              ttl: Math.floor(Date.now() / 1000) + (
                date === today ? 1800 :
                date >= addDays(today, -2) ? 3600 :
                date >= addDays(today, -30) ? 604800 :
                2592000
              ),
            },
          },
        })),
      },
    }))
  }
}

// ── Smart fetch: cache first, then bulk API for misses ─

async function getRevenueForDates(dates) {
  if (!dates.length) return {}

  // Check cache
  const cached = await getCachedDates(dates)
  const uncached = dates.filter(d => !cached[d])

  if (uncached.length > 0) {
    // Find contiguous ranges to minimise API calls
    const sorted = [...uncached].sort()
    const ranges = []
    let rangeStart = sorted[0]
    let rangePrev = sorted[0]

    for (let i = 1; i < sorted.length; i++) {
      const expected = addDays(rangePrev, 1)
      if (sorted[i] === expected) {
        rangePrev = sorted[i]
      } else {
        ranges.push([rangeStart, rangePrev])
        rangeStart = sorted[i]
        rangePrev = sorted[i]
      }
    }
    ranges.push([rangeStart, rangePrev])

    // Fetch each range from Prosper
    for (const [start, end] of ranges) {
      const fetched = await fetchRevenueRange(start, end)
      // Fill in zeros for dates with no data
      const rangeDates = dateRange(start, end)
      const toCache = {}
      for (const d of rangeDates) {
        const val = fetched[d] || { revenue: 0, impressions: 0 }
        cached[d] = val
        toCache[d] = val
      }
      // Cache in background (don't await to save time)
      cacheDates(toCache).catch(() => {})
    }
  }

  return cached
}

// ── Summarise a set of daily data ─────────────────────

function summarise(dateMap, dates) {
  let totalRevenue = 0
  let totalImpressions = 0
  const daily = []

  for (const d of dates) {
    const val = dateMap[d] || { revenue: 0, impressions: 0 }
    totalRevenue += val.revenue
    totalImpressions += val.impressions
    daily.push({ date: d, ...val })
  }

  return {
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalImpressions,
    avgDailyRevenue: dates.length ? Math.round(totalRevenue / dates.length * 100) / 100 : 0,
    days: dates.length,
    daily,
  }
}

// ── Lambda handler ────────────────────────────────────

export async function handler(event) {
  try {
    // ── Scheduled preload (EventBridge) ───────────────
    if (event.source === 'aws.events' || event['detail-type'] === 'Scheduled Event') {
      console.log('Cache preload triggered')
      const today = toDateStr(new Date())
      const yesterday = addDays(today, -1)

      // Preload common periods: 7d, 30d, 90d + their comparisons + YoY
      const start90 = addDays(yesterday, -89)
      const prevStart90 = addDays(start90, -90)
      const yoyStart = addDays(start90, -365)
      const yoyEnd = addDays(yesterday, -365)
      const rollingStart = addDays(yesterday, -364)

      const allDates = [...new Set([
        ...dateRange(prevStart90, yesterday),   // covers current 90d + prev 90d
        ...dateRange(yoyStart, yoyEnd),          // YoY for 90d
        ...dateRange(rollingStart, yesterday),   // 12-month rolling
      ])].sort()

      await getRevenueForDates(allDates)
      console.log(`Preloaded ${allDates.length} dates into cache`)

      return { statusCode: 200, body: JSON.stringify({ preloaded: allDates.length }) }
    }

    // ── HTTP request ──────────────────────────────────
    const params = event.queryStringParameters || {}
    const today = toDateStr(new Date())

    const days = Math.min(parseInt(params.days) || 7, 90)

    // Current period: last N days ending yesterday (skip today)
    const yesterday = addDays(today, -1)
    const periodStart = addDays(yesterday, -(days - 1))
    const currentDates = dateRange(periodStart, yesterday)

    // Previous period: the N days immediately before current period
    const prevEnd = addDays(periodStart, -1)
    const prevStart = addDays(prevEnd, -(days - 1))
    const prevDates = dateRange(prevStart, prevEnd)

    // YoY: same dates, one year ago
    const yoyStart = addDays(periodStart, -365)
    const yoyEnd = addDays(yesterday, -365)
    const yoyDates = dateRange(yoyStart, yoyEnd)

    // 12-month rolling average: last 365 days ending yesterday
    const rollingStart = addDays(yesterday, -364)
    const rollingDates = dateRange(rollingStart, yesterday)

    // Collect all unique dates we need
    const allDates = [...new Set([...currentDates, ...prevDates, ...yoyDates, ...rollingDates])].sort()

    // Fetch everything
    const allData = await getRevenueForDates(allDates)

    // Compute summaries
    const current = summarise(allData, currentDates)
    const previous = summarise(allData, prevDates)
    const yoy = summarise(allData, yoyDates)
    const rolling = summarise(allData, rollingDates)

    // Rolling average projected to period length
    const rollingProjected = rolling.days
      ? Math.round(rolling.avgDailyRevenue * days * 100) / 100
      : 0

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary: {
          ...current,
          startDate: periodStart,
          endDate: yesterday,
        },
        daily: current.daily,
        comparisons: {
          previous: {
            totalRevenue: previous.totalRevenue,
            avgDailyRevenue: previous.avgDailyRevenue,
            days: previous.days,
            startDate: prevStart,
            endDate: prevEnd,
            change: current.totalRevenue && previous.totalRevenue
              ? Math.round((current.totalRevenue - previous.totalRevenue) / previous.totalRevenue * 10000) / 100
              : null,
          },
          yoy: {
            totalRevenue: yoy.totalRevenue,
            avgDailyRevenue: yoy.avgDailyRevenue,
            days: yoy.days,
            startDate: yoyStart,
            endDate: yoyEnd,
            change: current.totalRevenue && yoy.totalRevenue
              ? Math.round((current.totalRevenue - yoy.totalRevenue) / yoy.totalRevenue * 10000) / 100
              : null,
          },
          rolling12m: {
            avgDailyRevenue: rolling.avgDailyRevenue,
            projectedTotal: rollingProjected,
            days: rolling.days,
            change: current.totalRevenue && rollingProjected
              ? Math.round((current.totalRevenue - rollingProjected) / rollingProjected * 10000) / 100
              : null,
          },
        },
      }),
    }
  } catch (err) {
    console.error('Revenue error:', err)
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to fetch revenue data' }),
    }
  }
}
