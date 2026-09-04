import assert from 'node:assert/strict'

export function readyUrl(output) {
  // Wait for the complete line, including the token even if stdout splits it.
  return output.match(/^dsh web: (http:\/\/127\.0\.0\.1:\d+(?:\/[^\s]*)?)(?: [^\n]*)?\r?\n/m)?.[1]
}

export function clientUrl(html, packageName) {
  const rows = [...html.matchAll(/"id"\s*:\s*"([^"]+)"\s*,\s*"url"\s*:\s*"([^"]+)"/g)]
  const row = rows.find(value => value[1] === packageName)
  assert.ok(row, 'the client must have a URL in the official boot manifest')
  return JSON.parse('"' + row[2] + '"')
}

export async function authenticatedIndex(launchUrl) {
  const url = new URL(launchUrl)
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.pathname, '/')
  const headers = {}
  if (url.searchParams.has('token')) {
    assert.equal((await fetch(url.origin)).status, 401, 'new runtime must preserve authentication')
    const exchange = await fetch(url, { redirect: 'manual' })
    assert.equal(exchange.status, 303)
    assert.equal(exchange.headers.get('location'), '/')
    const cookies = exchange.headers.getSetCookie()
    assert.ok(cookies.length > 0)
    assert.ok(cookies.every(value => /HttpOnly/i.test(value)))
    headers.cookie = cookies.map(value => value.split(';')[0]).join('; ')
  }
  return { response: await fetch(url.origin, { headers }), headers, origin: url.origin }
}
