let lineChart, barChart, sse;
const API_BASE = typeof window !== 'undefined' && window.API_BASE_URL ? window.API_BASE_URL : '';

async function init() {
  const meRes = await fetch(`${API_BASE}/api/me`);
  if (!meRes.ok) {
    location.href = '/login.html';
    return;
  }
  const me = await meRes.json();
  document.getElementById('userEmail').textContent = me.user.email;
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch(`${API_BASE}/api/logout`, { method: 'POST' });
    location.href = '/';
  });

  await loadWatchlist();
  connectStream();
  wireSearch();
  wireAlerts();
}

async function loadWatchlist() {
  const res = await fetch(`${API_BASE}/api/watchlist`);
  const data = await res.json();
  const ul = document.getElementById('watchlist');
  ul.innerHTML = '';
  data.symbols.forEach((symbol) => {
    const li = document.createElement('li');
    li.className = 'py-2 flex items-center justify-between';
    li.innerHTML = `
      <div>
        <div class="font-medium">${symbol}</div>
        <div class="text-sm text-gray-600"><span id="price-${symbol}">—</span> (<span id="pct-${symbol}">—</span>%)</div>
      </div>
      <div class="flex items-center gap-2">
        <button class="text-blue-600 hover:underline" data-action="chart" data-symbol="${symbol}">Chart</button>
        <button class="text-red-600 hover:underline" data-action="remove" data-symbol="${symbol}">Remove</button>
      </div>
    `;
    ul.appendChild(li);
  });
  ul.querySelectorAll('button').forEach((btn) => {
    const symbol = btn.getAttribute('data-symbol');
    const action = btn.getAttribute('data-action');
    if (action === 'chart') {
      btn.addEventListener('click', () => loadCharts(symbol));
    } else if (action === 'remove') {
      btn.addEventListener('click', async () => {
        await fetch(`${API_BASE}/api/watchlist/${symbol}`, { method: 'DELETE' });
        await loadWatchlist();
      });
    }
  });
}

function connectStream() {
  try {
    sse = new EventSource(`${API_BASE}/api/stream`);
    const status = document.getElementById('streamStatus');
    status.textContent = 'Connected';
    status.className = 'inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700 dark:bg-green-800 dark:text-green-200';
    sse.addEventListener('quote', (ev) => {
      const q = JSON.parse(ev.data);
      const priceEl = document.getElementById(`price-${q.symbol}`);
      const pctEl = document.getElementById(`pct-${q.symbol}`);
      if (priceEl) priceEl.textContent = q.price.toFixed(2);
      if (pctEl) {
        pctEl.textContent = q.changePercent.toFixed(2);
        pctEl.className = q.changePercent >= 0 ? 'text-green-600' : 'text-red-600';
      }
    });
    sse.addEventListener('alert', (ev) => {
      const a = JSON.parse(ev.data);
      const li = document.createElement('li');
      li.className = 'py-2';
      li.textContent = a.message;
      document.getElementById('alertsList').prepend(li);
    });
    sse.onerror = () => {
      const status2 = document.getElementById('streamStatus');
      status2.textContent = 'Disconnected';
      status2.className = 'inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300';
    };
  } catch (e) {
    const status3 = document.getElementById('streamStatus');
    status3.textContent = 'Disconnected';
    status3.className = 'inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300';
  }
}

function wireSearch() {
  const input = document.getElementById('searchInput');
  const btn = document.getElementById('searchBtn');
  const ul = document.getElementById('searchResults');
  btn.addEventListener('click', async () => {
    const q = input.value.trim();
    if (!q) return;
    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = 'Searching…';
    const res = await fetch(`${API_BASE}/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    ul.innerHTML = '';
    data.results.forEach((r) => {
      const li = document.createElement('li');
      li.className = 'py-2 flex items-center justify-between';
      li.innerHTML = `
        <div>
          <div class="font-medium">${r.symbol}</div>
          <div class="text-sm text-gray-600">${r.name} • ${r.region} • ${r.currency}</div>
        </div>
        <div class="flex items-center gap-2">
          <button class="px-2 py-1 bg-blue-600 text-white rounded" data-action="add" data-symbol="${r.symbol}">Add</button>
          <button class="px-2 py-1 bg-gray-200 rounded" data-action="chart" data-symbol="${r.symbol}">Chart</button>
        </div>
      `;
      ul.appendChild(li);
    });
    ul.querySelectorAll('button').forEach((b) => {
      const symbol = b.getAttribute('data-symbol');
      const action = b.getAttribute('data-action');
      if (action === 'add') {
        b.addEventListener('click', async () => {
          await fetch(`${API_BASE}/api/watchlist`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol }),
          });
          await loadWatchlist();
        });
      } else if (action === 'chart') {
        b.addEventListener('click', () => loadCharts(symbol));
      }
    });
    btn.disabled = false;
    btn.textContent = origText;
  });
}

async function loadCharts(symbol) {
  const interval = document.getElementById('intervalSelect').value;
  const overlay = document.getElementById('chartLoading');
  if (overlay) overlay.classList.remove('hidden');
  const res = await fetch(`${API_BASE}/api/historic?symbol=${encodeURIComponent(symbol)}&interval=${interval}`);
  const data = await res.json();
  const labels = data.points.map((p) => p.t);
  const closes = data.points.map((p) => p.close);
  const volumes = data.points.map((p) => p.volume);

  const lineCtx = document.getElementById('lineChart');
  const barCtx = document.getElementById('barChart');

  if (lineChart) lineChart.destroy();
  if (barChart) barChart.destroy();

  lineChart = new Chart(lineCtx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: `${symbol} Close`,
          data: closes,
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37, 99, 235, 0.2)',
          tension: 0.2,
        },
      ],
    },
    options: {
      plugins: {
        legend: { display: true },
      },
      scales: {
        x: { display: true },
        y: { display: true },
      },
    },
  });

  barChart = new Chart(barCtx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: `${symbol} Volume`,
          data: volumes,
          backgroundColor: '#10b981',
        },
      ],
    },
    options: {
      plugins: {
        legend: { display: true },
      },
      scales: {
        x: { display: true },
        y: { display: true },
      },
    },
  });
  if (overlay) overlay.classList.add('hidden');
}

function wireAlerts() {
  const form = document.getElementById('alertForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const symbol = document.getElementById('alertSymbol').value.trim().toUpperCase();
    const direction = document.getElementById('alertDirection').value;
    const price = parseFloat(document.getElementById('alertPrice').value);
    if (!symbol || !Number.isFinite(price)) return;
    await fetch(`${API_BASE}/api/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, direction, price }),
    });
    await loadAlerts();
  });
  loadAlerts();
}

async function loadAlerts() {
  const res = await fetch(`${API_BASE}/api/alerts`);
  const data = await res.json();
  const ul = document.getElementById('alertsList');
  ul.innerHTML = '';
  data.alerts.forEach((a) => {
    const li = document.createElement('li');
    li.className = 'py-2 flex items-center justify-between';
    li.innerHTML = `
      <div>${a.symbol} ${a.direction} ${a.price} ${a.active ? '' : '(triggered)'}</div>
      <button class="text-red-600 hover:underline" data-id="${a.id}">Delete</button>
    `;
    ul.appendChild(li);
  });
  ul.querySelectorAll('button').forEach((b) => {
    const id = b.getAttribute('data-id');
    b.addEventListener('click', async () => {
      await fetch(`${API_BASE}/api/alerts/${id}`, { method: 'DELETE' });
      await loadAlerts();
    });
  });
}

window.addEventListener('DOMContentLoaded', init);
