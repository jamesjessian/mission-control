// ── Config ─────────────────────────────────────────
const API_BASE = ''

// ── Menu ──────────────────────────────────────────
const menu = document.getElementById('slide-menu')
const overlay = document.getElementById('menu-overlay')
const hamburger = document.getElementById('hamburger')
const menuClose = document.getElementById('menu-close')
const pageTitle = document.getElementById('page-title')

function openMenu() {
  menu.classList.add('open')
  overlay.classList.add('open')
  document.body.classList.add('menu-open')
}

function closeMenu() {
  menu.classList.remove('open')
  overlay.classList.remove('open')
  document.body.classList.remove('menu-open')
}

hamburger.addEventListener('click', openMenu)
menuClose.addEventListener('click', closeMenu)
overlay.addEventListener('click', closeMenu)

let touchStartX = 0
menu.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX }, { passive: true })
menu.addEventListener('touchmove', e => {
  if (e.touches[0].clientX - touchStartX < -60) closeMenu()
}, { passive: true })

// ── Page Navigation ───────────────────────────────
const menuItems = document.querySelectorAll('.menu-item')
const pages = document.querySelectorAll('.page')
const pageTitles = { revenue: 'Revenue', players: 'Players', todo: 'Todo', documents: 'Documents' }

menuItems.forEach(item => {
  item.addEventListener('click', () => {
    const page = item.dataset.page
    menuItems.forEach(mi => mi.classList.remove('active'))
    item.classList.add('active')
    pages.forEach(p => p.classList.remove('active'))
    document.getElementById(`page-${page}`).classList.add('active')
    pageTitle.textContent = pageTitles[page] || page
    closeMenu()
    if (page === 'revenue' && !revenueData) fetchRevenue(currentDays)
    if (page === 'players' && !playersData) fetchPlayers(playersDays)
  })
})

// ── State ──────────────────────────────────────────
let currentDays = 7
let revenueData = null
let exchangeRate = null // USD→GBP
let currency = localStorage.getItem('mc-currency') || 'USD'

// ── Currency ──────────────────────────────────────

async function fetchExchangeRate() {
  try {
    const resp = await fetch('https://open.er-api.com/v6/latest/USD')
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json()
    exchangeRate = data.rates.GBP
  } catch {
    exchangeRate = null
  }
}

function convertAmount(usd) {
  if (currency === 'GBP' && exchangeRate) return usd * exchangeRate
  return usd
}

function formatCurrency(n) {
  const isGBP = currency === 'GBP' && exchangeRate
  const val = convertAmount(n)
  if (isGBP) {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency', currency: 'GBP', minimumFractionDigits: 2,
    }).format(val)
  }
  return '$' + new Intl.NumberFormat('en-GB', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(val)
}

function formatNumber(n) {
  return new Intl.NumberFormat('en-GB').format(n)
}

function updateCurrencyLabel() {
  setText('currency-label', currency === 'GBP' && exchangeRate ? 'GBP' : 'USD')
}

document.getElementById('currency-toggle').addEventListener('click', () => {
  currency = currency === 'USD' ? 'GBP' : 'USD'
  localStorage.setItem('mc-currency', currency)
  updateCurrencyLabel()
  if (revenueData) renderRevenue(revenueData)
})

// ── Revenue ────────────────────────────────────────

async function fetchRevenue(days) {
  const loading = document.getElementById('revenue-loading')
  const error = document.getElementById('revenue-error')
  loading.hidden = false
  error.hidden = true

  try {
    const resp = await fetch(`${API_BASE}/api/revenue?days=${days}`)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    revenueData = await resp.json()
    renderRevenue(revenueData)
  } catch (err) {
    error.textContent = `Failed to load revenue: ${err.message}`
    error.hidden = false
  } finally {
    loading.hidden = true
  }
}

function $(id) { return document.getElementById(id) }
function setText(id, text) { const el = $(id); if (el) el.textContent = text }

function renderRevenue(data) {
  const { summary, daily, comparisons } = data

  // Backend already excludes today — show the two most recent days with revenue
  const withRevenue = daily.filter(d => d.revenue > 0)
  const latest = withRevenue[withRevenue.length - 1]
  const prev = withRevenue.length > 1 ? withRevenue[withRevenue.length - 2] : null

  setText('latest-label', latest ? friendlyDateLabel(latest.date) : 'Yesterday')
  setText('previous-label', prev ? friendlyDateLabel(prev.date) : 'Day before')

  setText('latest-revenue', latest ? formatCurrency(latest.revenue) : '—')
  setText('previous-revenue', prev ? formatCurrency(prev.revenue) : '—')

  // Summary
  setText('total-revenue', formatCurrency(summary.totalRevenue))
  setText('avg-revenue', formatCurrency(summary.avgDailyRevenue))
  setText('total-impressions', formatNumber(summary.totalImpressions))

  // Comparisons
  if (comparisons) renderComparisons(comparisons)

  renderChart(daily)
}

function renderComparisons(comp) {
  // Previous period
  setText('comp-prev-label', `${comp.previous.days}d`)
  setText('comp-prev-amount', formatCurrency(comp.previous.totalRevenue))
  renderChange('comp-prev-change', comp.previous.change)

  // YoY
  setText('comp-yoy-amount', formatCurrency(comp.yoy.totalRevenue))
  renderChange('comp-yoy-change', comp.yoy.change)

  // Rolling 12m
  setText('comp-rolling-amount', formatCurrency(comp.rolling12m.projectedTotal))
  renderChange('comp-rolling-change', comp.rolling12m.change)
}

function renderChange(elementId, change) {
  const el = $(elementId)
  if (!el) return
  if (change === null || change === undefined) {
    el.textContent = '—'
    el.className = 'comparison-change flat'
    return
  }
  const sign = change > 0 ? '+' : ''
  el.textContent = `${sign}${change.toFixed(1)}%`
  el.className = `comparison-change ${change > 0 ? 'up' : change < 0 ? 'down' : 'flat'}`
}

function friendlyDateLabel(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diffDays = Math.round((today - target) / 86400000)

  if (diffDays === 1) return 'Yesterday'
  if (diffDays === 2) return 'Day before'
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

// ── Chart ──────────────────────────────────────────

function renderChart(daily) {
  const canvas = document.getElementById('revenue-chart')
  const color = '#111827'
  const values = daily.map(d => convertAmount(d.revenue))
  const labels = daily.map(d => d.date)
  const formatValue = v => formatCurrency(v)

  drawBarChart(canvas, values, labels, color, formatValue)
}

// ── Shared Bar Chart Renderer ─────────────────────────

function drawBarChart(canvas, values, labels, color, formatValue, highlightIdx) {
  const ctx = canvas.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.parentElement.getBoundingClientRect()

  canvas.width = rect.width * dpr
  canvas.height = rect.height * dpr
  ctx.scale(dpr, dpr)

  const w = rect.width
  const h = rect.height
  const pad = { top: 8, right: 8, bottom: 24, left: 0 }
  const chartW = w - pad.left - pad.right
  const chartH = h - pad.top - pad.bottom

  ctx.clearRect(0, 0, w, h)
  if (!values.length) return

  const max = Math.max(...values, 1)

  const barGap = 2
  const barWidth = Math.max(1, (chartW - barGap * (values.length - 1)) / values.length)

  // Store chart geometry for interaction
  canvas._chartMeta = { values, labels, pad, barWidth, barGap, color, formatValue }

  values.forEach((val, i) => {
    const x = pad.left + i * (barWidth + barGap)
    const barH = Math.max(val > 0 ? 1 : 0, val / max * chartH)
    const y = pad.top + chartH - barH

    const isHighlight = highlightIdx === i
    const isActive = highlightIdx != null

    if (isActive && !isHighlight) {
      ctx.fillStyle = val > 0 ? (color + '40') : '#e5e7eb'
    } else {
      ctx.fillStyle = val > 0 ? color : '#d1d5db'
    }

    ctx.beginPath()
    const r = Math.min(3, barWidth / 2)
    ctx.roundRect(x, y, barWidth, barH, [r, r, 0, 0])
    ctx.fill()
  })

  // Date labels along x-axis
  ctx.fillStyle = '#9ca3af'
  ctx.font = '10px -apple-system, system-ui, sans-serif'
  ctx.textBaseline = 'top'

  const labelY = pad.top + chartH + 6
  const indices = [0, Math.floor(values.length / 2), values.length - 1]
  const aligns = ['left', 'center', 'right']

  indices.forEach((idx, i) => {
    if (idx >= labels.length) return
    const label = formatDateLabel(labels[idx])
    const x = pad.left + idx * (barWidth + barGap) + barWidth / 2
    ctx.textAlign = aligns[i]
    ctx.fillText(label, x, labelY)
  })

  // Set up interaction once
  if (!canvas._chartBound) {
    setupChartInteraction(canvas)
    canvas._chartBound = true
  }
}

// ── Chart Interaction (touch/mouse scrub) ──────────────

function setupChartInteraction(canvas) {
  // Create tooltip element
  const tooltip = document.createElement('div')
  tooltip.className = 'chart-tooltip'
  tooltip.hidden = true
  canvas.parentElement.appendChild(tooltip)
  canvas._tooltip = tooltip

  let active = false

  function getBarIndex(clientX) {
    const meta = canvas._chartMeta
    if (!meta) return -1
    const rect = canvas.getBoundingClientRect()
    const x = clientX - rect.left
    const { pad, barWidth, barGap, values } = meta
    // Calculate which bar the x position corresponds to
    const relX = x - pad.left
    const step = barWidth + barGap
    let idx = Math.round(relX / step)
    idx = Math.max(0, Math.min(values.length - 1, idx))
    return idx
  }

  function showTooltip(clientX) {
    const meta = canvas._chartMeta
    if (!meta) return
    const idx = getBarIndex(clientX)
    if (idx < 0) return

    const { values, labels, formatValue, color } = meta
    const date = labels[idx]
    const val = values[idx]

    const tooltip = canvas._tooltip
    const dateLabel = formatDateLabel(date)
    tooltip.innerHTML = `<span class="chart-tooltip-date">${dateLabel}</span><span class="chart-tooltip-value" style="color:${color}">${formatValue(val)}</span>`
    tooltip.hidden = false

    // Redraw with highlight
    drawBarChart(canvas, values, labels, color, formatValue, idx)
  }

  function hideTooltip() {
    active = false
    canvas._tooltip.hidden = true
    const meta = canvas._chartMeta
    if (meta) {
      drawBarChart(canvas, meta.values, meta.labels, meta.color, meta.formatValue)
    }
  }

  // Mouse events
  canvas.addEventListener('mousedown', e => {
    active = true
    showTooltip(e.clientX)
  })
  canvas.addEventListener('mousemove', e => {
    if (active) showTooltip(e.clientX)
  })
  canvas.addEventListener('mouseup', hideTooltip)
  canvas.addEventListener('mouseleave', () => {
    if (active) hideTooltip()
  })

  // Touch events
  canvas.addEventListener('touchstart', e => {
    active = true
    showTooltip(e.touches[0].clientX)
    e.preventDefault()
  }, { passive: false })
  canvas.addEventListener('touchmove', e => {
    if (active) {
      showTooltip(e.touches[0].clientX)
      e.preventDefault()
    }
  }, { passive: false })
  canvas.addEventListener('touchend', hideTooltip)
  canvas.addEventListener('touchcancel', hideTooltip)
}

function formatDateLabel(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

// ── Tab Handling ───────────────────────────────────

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    currentDays = parseInt(tab.dataset.days)
    fetchRevenue(currentDays)
  })
})

// ── Document Search ────────────────────────────────

document.getElementById('search-btn').addEventListener('click', doSearch)
document.getElementById('search-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') doSearch()
})

async function doSearch() {
  const query = document.getElementById('search-input').value.trim()
  if (!query) return

  const results = document.getElementById('search-results')
  const placeholder = document.getElementById('search-placeholder')
  placeholder.hidden = true
  results.innerHTML = '<p class="muted">Searching…</p>'

  try {
    const resp = await fetch(`${API_BASE}/api/documents/search?q=${encodeURIComponent(query)}`)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json()
    renderSearchResults(data.results, query)
  } catch {
    results.innerHTML = '<p class="muted">Document search coming soon</p>'
  }
}

function renderSearchResults(items, query) {
  const container = document.getElementById('search-results')
  if (!items || !items.length) {
    container.innerHTML = '<p class="muted">No results found</p>'
    return
  }
  container.innerHTML = items.map(item => `
    <div class="search-result">
      <div class="search-result-title">${escapeHtml(item.filename)}</div>
      <div class="search-result-snippet">${highlightSnippet(item.snippet, query)}</div>
    </div>
  `).join('')
}

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

function highlightSnippet(snippet, query) {
  const escaped = escapeHtml(snippet)
  const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
  return escaped.replace(re, '<mark>$1</mark>')
}

// ── Resize ─────────────────────────────────────────

let resizeTimeout
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout)
  resizeTimeout = setTimeout(() => {
    if (revenueData) renderRevenue(revenueData)
    if (playersData) renderPlayers(playersData)
  }, 150)
})

// ── Keyboard ───────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeMenu()
})

// ── Todo ─────────────────────────────────────────────

const TODO_KEY = 'mc-todos'

function loadTodos() {
  try { return JSON.parse(localStorage.getItem(TODO_KEY)) || { home: [], work: [] } }
  catch { return { home: [], work: [] } }
}

function saveTodos(todos) {
  localStorage.setItem(TODO_KEY, JSON.stringify(todos))
}

function createId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function renderTodos() {
  const todos = loadTodos()
  document.querySelectorAll('.todo-section').forEach(section => {
    const listName = section.dataset.list
    const ul = section.querySelector('.todo-list')
    ul.innerHTML = ''
    const items = todos[listName] || []
    items.forEach((item, idx) => {
      const li = document.createElement('li')
      li.className = 'todo-item' + (item.done ? ' done' : '')
      li.draggable = true
      li.dataset.id = item.id
      li.dataset.list = listName
      li.dataset.idx = idx

      li.innerHTML = `
        <div class="todo-row">
          <span class="todo-drag" aria-label="Drag to reorder">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/>
              <circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/>
              <circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>
            </svg>
          </span>
          <label class="todo-check">
            <input type="checkbox" ${item.done ? 'checked' : ''}>
            <span class="todo-checkmark"></span>
          </label>
          <span class="todo-text">${escapeHtml(item.text)}</span>
          <button class="todo-expand" aria-label="Details">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="m6 9 6 6 6-6"/>
            </svg>
          </button>
          <button class="todo-delete" aria-label="Delete">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
            </svg>
          </button>
        </div>
        <div class="todo-details" hidden>
          <textarea class="todo-notes" placeholder="Add notes…" rows="2">${escapeHtml(item.notes || '')}</textarea>
        </div>
      `

      // Checkbox
      li.querySelector('input[type=checkbox]').addEventListener('change', e => {
        const t = loadTodos()
        t[listName][idx].done = e.target.checked
        saveTodos(t)
        renderTodos()
      })

      // Expand
      li.querySelector('.todo-expand').addEventListener('click', () => {
        const details = li.querySelector('.todo-details')
        const wasHidden = details.hidden
        details.hidden = !wasHidden
        li.classList.toggle('expanded', wasHidden)
        if (wasHidden) li.querySelector('.todo-notes').focus()
      })

      // Notes
      li.querySelector('.todo-notes').addEventListener('input', e => {
        const t = loadTodos()
        t[listName][idx].notes = e.target.value
        saveTodos(t)
      })

      // Delete
      li.querySelector('.todo-delete').addEventListener('click', () => {
        const t = loadTodos()
        t[listName].splice(idx, 1)
        saveTodos(t)
        renderTodos()
      })

      // Drag events
      li.addEventListener('dragstart', handleDragStart)
      li.addEventListener('dragover', handleDragOver)
      li.addEventListener('dragenter', handleDragEnter)
      li.addEventListener('dragleave', handleDragLeave)
      li.addEventListener('drop', handleDrop)
      li.addEventListener('dragend', handleDragEnd)

      // Touch reorder
      const dragHandle = li.querySelector('.todo-drag')
      dragHandle.addEventListener('touchstart', handleTouchStart, { passive: false })

      ul.appendChild(li)
    })
  })
}

// ── Drag & Drop ──────────────────────────────────────

let dragItem = null

function handleDragStart(e) {
  dragItem = this
  this.classList.add('dragging')
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', this.dataset.id)
}

function handleDragOver(e) {
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
}

function handleDragEnter(e) {
  e.preventDefault()
  if (this !== dragItem && this.classList.contains('todo-item')) {
    this.classList.add('drag-over')
  }
}

function handleDragLeave() {
  this.classList.remove('drag-over')
}

function handleDrop(e) {
  e.preventDefault()
  this.classList.remove('drag-over')
  if (!dragItem || this === dragItem) return

  const fromList = dragItem.dataset.list
  const fromIdx = parseInt(dragItem.dataset.idx)
  const toList = this.dataset.list
  const toIdx = parseInt(this.dataset.idx)

  if (fromList !== toList) return

  const todos = loadTodos()
  const [moved] = todos[fromList].splice(fromIdx, 1)
  todos[toList].splice(toIdx, 0, moved)
  saveTodos(todos)
  renderTodos()
}

function handleDragEnd() {
  this.classList.remove('dragging')
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'))
  dragItem = null
}

// ── Touch Reorder ────────────────────────────────────

let touchDragItem = null
let touchClone = null
let touchStartTodoY = 0

function handleTouchStart(e) {
  const li = e.target.closest('.todo-item')
  if (!li) return
  e.preventDefault()

  touchDragItem = li
  touchStartTodoY = e.touches[0].clientY
  const rect = li.getBoundingClientRect()

  touchClone = li.cloneNode(true)
  touchClone.classList.add('todo-ghost')
  touchClone.style.width = rect.width + 'px'
  touchClone.style.top = rect.top + 'px'
  touchClone.style.left = rect.left + 'px'
  document.body.appendChild(touchClone)
  li.classList.add('dragging')

  document.addEventListener('touchmove', handleTodoTouchMove, { passive: false })
  document.addEventListener('touchend', handleTodoTouchEnd)
}

function handleTodoTouchMove(e) {
  if (!touchClone) return
  e.preventDefault()
  const y = e.touches[0].clientY
  const dy = y - touchStartTodoY
  touchClone.style.transform = `translateY(${dy}px)`

  touchClone.style.pointerEvents = 'none'
  const el = document.elementFromPoint(e.touches[0].clientX, y)
  touchClone.style.pointerEvents = ''
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'))
  const target = el?.closest('.todo-item')
  if (target && target !== touchDragItem) target.classList.add('drag-over')
}

function handleTodoTouchEnd() {
  document.removeEventListener('touchmove', handleTodoTouchMove)
  document.removeEventListener('touchend', handleTodoTouchEnd)

  if (touchClone) {
    touchClone.remove()
    touchClone = null
  }

  const overEl = document.querySelector('.drag-over')
  if (overEl && touchDragItem && overEl !== touchDragItem) {
    const fromList = touchDragItem.dataset.list
    const fromIdx = parseInt(touchDragItem.dataset.idx)
    const toList = overEl.dataset.list
    const toIdx = parseInt(overEl.dataset.idx)

    if (fromList === toList) {
      const todos = loadTodos()
      const [moved] = todos[fromList].splice(fromIdx, 1)
      todos[toList].splice(toIdx, 0, moved)
      saveTodos(todos)
    }
  }

  document.querySelectorAll('.dragging, .drag-over').forEach(el => {
    el.classList.remove('dragging', 'drag-over')
  })
  touchDragItem = null
  renderTodos()
}

// ── Add task ─────────────────────────────────────────

document.querySelectorAll('.todo-section').forEach(section => {
  const listName = section.dataset.list
  const input = section.querySelector('.todo-input')
  const btn = section.querySelector('.todo-add-btn')

  function addTask() {
    const text = input.value.trim()
    if (!text) return
    const todos = loadTodos()
    todos[listName].push({ id: createId(), text, done: false, notes: '' })
    saveTodos(todos)
    input.value = ''
    renderTodos()
  }

  btn.addEventListener('click', addTask)
  input.addEventListener('keydown', e => { if (e.key === 'Enter') addTask() })
})

// ── Todo tabs ───────────────────────────────────────

let activeTodoList = localStorage.getItem('mc-todo-tab') || 'home'

function switchTodoTab(listName) {
  activeTodoList = listName
  localStorage.setItem('mc-todo-tab', listName)
  document.querySelectorAll('.todo-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.list === listName)
  })
  document.querySelectorAll('.todo-section').forEach(s => {
    s.classList.toggle('active', s.dataset.list === listName)
  })
}

document.querySelectorAll('.todo-tab').forEach(tab => {
  tab.addEventListener('click', () => switchTodoTab(tab.dataset.list))
})

switchTodoTab(activeTodoList)
renderTodos()

// ── Players ──────────────────────────────────────────

let playersDays = 7
let playersData = null

const GAME_COLORS = {
  waffle: '#f59e0b',
  ows: '#3b82f6',
  stackdown: '#10b981',
  lettergrams: '#8b5cf6',
}

async function fetchPlayers(days) {
  const loading = document.getElementById('players-loading')
  const error = document.getElementById('players-error')
  loading.hidden = false
  error.hidden = true

  try {
    const resp = await fetch(`${API_BASE}/api/players?days=${days}`)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    playersData = await resp.json()
    renderPlayers(playersData)
  } catch (err) {
    error.textContent = `Failed to load players: ${err.message}`
    error.hidden = false
  } finally {
    loading.hidden = true
  }
}

function renderPlayers(data) {
  const container = document.getElementById('players-games')
  container.innerHTML = ''

  const gameOrder = ['waffle', 'ows', 'stackdown', 'lettergrams']

  for (const key of gameOrder) {
    const game = data.games[key]
    if (!game) continue

    const { current, previous, label } = game
    const color = GAME_COLORS[key]

    // Find latest day with data
    const withData = current.daily.filter(d => d.players > 0)
    const latest = withData[withData.length - 1]
    const prev = withData.length > 1 ? withData[withData.length - 2] : null

    const section = document.createElement('div')
    section.className = 'players-game'
    section.innerHTML = `
      <div class="players-game-header">
        <span class="players-game-dot" style="background:${color}"></span>
        <span class="players-game-label">${label}</span>
      </div>
      <div class="players-game-hero">
        <div class="hero-stat">
          <span class="hero-label">${latest ? friendlyDateLabel(latest.date) : 'Latest'}</span>
          <span class="hero-value players-hero-value">${latest ? formatNumber(latest.players) : '—'}</span>
        </div>
        ${prev ? `
        <div class="hero-stat">
          <span class="hero-label">${friendlyDateLabel(prev.date)}</span>
          <span class="hero-value secondary">${formatNumber(prev.players)}</span>
        </div>` : ''}
      </div>
      <div class="players-game-summary">
        <div class="summary-item">
          <span class="summary-label">Daily avg</span>
          <span class="summary-value">${formatNumber(current.avg)}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">Period total</span>
          <span class="summary-value">${formatNumber(current.total)}</span>
        </div>
        <div class="summary-item">
          <span class="summary-label">vs prev ${data.days}d</span>
          <span class="summary-value">${renderChangeInline(previous.change)}</span>
        </div>
      </div>
      <div class="players-chart-container">
        <canvas class="players-chart" data-game="${key}"></canvas>
      </div>
    `
    container.appendChild(section)

    // Render chart
    const canvas = section.querySelector('.players-chart')
    renderPlayersChart(canvas, current.daily, color)
  }
}

function renderChangeInline(change) {
  if (change === null || change === undefined) return '<span class="comparison-change flat">—</span>'
  const sign = change > 0 ? '+' : ''
  const cls = change > 0 ? 'up' : change < 0 ? 'down' : 'flat'
  return `<span class="comparison-change ${cls}">${sign}${change.toFixed(1)}%</span>`
}

function renderPlayersChart(canvas, daily, color) {
  const values = daily.map(d => d.players)
  const labels = daily.map(d => d.date)
  const formatValue = v => formatNumber(v)

  drawBarChart(canvas, values, labels, color, formatValue)
}

// Players tab handling
document.querySelectorAll('#players-tabs .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#players-tabs .tab').forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    playersDays = parseInt(tab.dataset.days)
    playersData = null
    fetchPlayers(playersDays)
  })
})

// ── Init ───────────────────────────────────────────

updateCurrencyLabel()
fetchExchangeRate().then(() => {
  updateCurrencyLabel()
  fetchRevenue(currentDays)
})
