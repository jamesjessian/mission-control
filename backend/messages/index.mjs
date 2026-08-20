import { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'
import { readFileSync } from 'fs'

const BUCKET = 'assets.waffle.game'
const PREFIX = 'dailymessage/'
const s3 = new S3Client({ region: 'eu-west-2' })

// Load compact emoji map: { shortname: "unified_codepoint" }
const emojiMap = JSON.parse(readFileSync(new URL('./emoji-map.json', import.meta.url), 'utf8'))

// ── Months ────────────────────────────────────────────
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

// ── Format Monday Message ─────────────────────────────

function formatMondayMessage(raw, url, image, imageUrl) {
  // Parse date from "Monday the Xth of Month"
  const dateMatch = raw.match(/Monday the (\d+)\w* of (\w+)/)
  if (!dateMatch) throw new Error('Could not parse date — expected "Monday the Xth of Month"')

  const dayOfMonth = parseInt(dateMatch[1])
  const month = dateMatch[2]
  const monthIndex = MONTHS.indexOf(month)
  if (monthIndex === -1) throw new Error('Invalid month: ' + month)

  let year = new Date().getFullYear()
  const currentMonth = new Date().getMonth()
  if (monthIndex < currentMonth) year++

  const isoDate = [
    String(year),
    String(monthIndex + 1).padStart(2, '0'),
    String(dayOfMonth).padStart(2, '0'),
  ].join('-')

  // Validate it's a Monday
  if (new Date(isoDate + 'T12:00:00Z').getUTCDay() !== 1) {
    throw new Error('Date is not a Monday: ' + isoDate)
  }

  // Extract day-of-year name (e.g. "Vanilla Custard Day")
  const doyMatch = raw.match(/which is, of course, ([^!]+)!/)
  const dayOfYear = doyMatch ? doyMatch[1].trim() : null

  let text = raw.trim()

  // Bold the date
  text = text.replace('Monday the ', '<b>Monday the ')
  text = text.replace(MONTHS[monthIndex], MONTHS[monthIndex] + '</b>')

  // Convert Slack emoji shortcodes to unicode
  text = text.replace(/:[a-z0-9_+-]+:/g, match => {
    const shortName = match.replace(/:/g, '')
    const unified = emojiMap[shortName]
    if (!unified) return match
    // Handle multi-codepoint emoji (e.g. "1F1EC-1F1E7")
    return unified.split('-').map(cp => String.fromCodePoint(parseInt(cp, 16))).join('')
  })

  // Newlines → <br/>
  text = text.replace(/\n+/g, '\n<br/>\n<br/>\n')

  // Link day-of-year
  if (dayOfYear && url) {
    text = text.replace(dayOfYear, `<a href="${url}">${dayOfYear}</a>`)
  }

  // Link "Deluxe Waffle"
  text = text.replace(/Deluxe Waffle/g, '<a href="#" class="deluxe-link">Deluxe Waffle</a>')

  // Add image if provided
  if (image) {
    const imageStyle = 'border-radius: 14px; width: 90%; max-width: 90%'
    text += '\n<br />\n<br />\n'
    if (imageUrl) text += `<a href="${imageUrl}" target="_blank">`
    else text += '<a href="#" class="deluxe-link">'
    text += `<img src="${image}" style="${imageStyle}" alt="${dayOfYear || 'Monday message'}" />`
    text += '</a>'
  }

  return { html: text.trim(), date: isoDate, dayOfYear }
}

// ── S3 Operations ─────────────────────────────────────

async function uploadMessage(date, html) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `${PREFIX}${date}.html`,
    Body: html,
    ContentType: 'text/html; charset=utf-8',
    ACL: 'public-read',
  }))
}

async function deleteMessage(date) {
  await s3.send(new DeleteObjectCommand({
    Bucket: BUCKET,
    Key: `${PREFIX}${date}.html`,
  }))
}

async function listMessages() {
  const messages = []
  let continuationToken

  do {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: PREFIX,
      ContinuationToken: continuationToken,
    }))

    for (const obj of (resp.Contents || [])) {
      const key = obj.Key
      const dateMatch = key.match(/(\d{4}-\d{2}-\d{2})\.html$/)
      if (dateMatch) {
        messages.push({
          date: dateMatch[1],
          key,
          size: obj.Size,
          lastModified: obj.LastModified?.toISOString(),
        })
      }
    }

    continuationToken = resp.NextContinuationToken
  } while (continuationToken)

  // Sort descending (newest first)
  messages.sort((a, b) => b.date.localeCompare(a.date))
  return messages
}

async function getMessage(date) {
  try {
    const resp = await s3.send(new GetObjectCommand({
      Bucket: BUCKET,
      Key: `${PREFIX}${date}.html`,
    }))
    const html = await resp.Body.transformToString()
    return html
  } catch (err) {
    if (err.name === 'NoSuchKey') return null
    throw err
  }
}

// ── Lambda Handler ────────────────────────────────────

export async function handler(event) {
  const method = event.requestContext?.http?.method || event.httpMethod
  const params = event.queryStringParameters || {}

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  }

  try {
    // GET /api/messages — list all, or get one if ?date= provided
    if (method === 'GET') {
      if (params.date) {
        const html = await getMessage(params.date)
        if (!html) {
          return { statusCode: 404, headers, body: JSON.stringify({ error: 'Message not found' }) }
        }
        return { statusCode: 200, headers, body: JSON.stringify({ date: params.date, html }) }
      }

      const messages = await listMessages()
      return { statusCode: 200, headers, body: JSON.stringify({ messages }) }
    }

    // POST /api/messages — format + optionally upload
    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}')
      const { raw, url, image, imageUrl, preview } = body

      if (!raw) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing raw text' }) }
      }

      const result = formatMondayMessage(raw, url || '', image || '', imageUrl || '')

      if (!preview) {
        await uploadMessage(result.date, result.html)
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ...result,
          uploaded: !preview,
          url: `https://assets.waffle.game/${PREFIX}${result.date}.html`,
        }),
      }
    }

    // DELETE /api/messages?date=YYYY-MM-DD
    if (method === 'DELETE') {
      if (!params.date) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing date parameter' }) }
      }

      await deleteMessage(params.date)
      return { statusCode: 200, headers, body: JSON.stringify({ deleted: params.date }) }
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) }
  } catch (err) {
    console.error('Messages error:', err)
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || 'Internal error' }),
    }
  }
}
