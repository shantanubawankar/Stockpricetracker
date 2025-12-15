const path = require('path');
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const axios = require('axios');
const dotenv = require('dotenv');
const morgan = require('morgan');
const Database = require('better-sqlite3');

dotenv.config();

const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY || '';
const PORT = process.env.PORT || 3000;

const app = express();

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS watchlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    UNIQUE(user_id, symbol),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('above','below')),
    price REAL NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    store: new SQLiteStore({
      db: 'sessions.sqlite',
      dir: __dirname,
    }),
    secret: process.env.SESSION_SECRET || 'dev_secret_change_me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
);

app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.post('/api/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    const hash = await bcrypt.hash(password, 12);
    const stmt = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)');
    const info = stmt.run(email.toLowerCase(), hash);
    req.session.userId = info.lastInsertRowid;
    res.json({ ok: true });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    const row = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email.toLowerCase());
    if (!row) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    req.session.userId = row.id;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, created_at FROM users WHERE id = ?').get(req.session.userId);
  res.json({ user });
});

app.get('/api/watchlist', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT symbol FROM watchlist WHERE user_id = ? ORDER BY symbol').all(req.session.userId);
  res.json({ symbols: rows.map(r => r.symbol) });
});

app.post('/api/watchlist', requireAuth, (req, res) => {
  const { symbol } = req.body;
  if (!symbol) return res.status(400).json({ error: 'Symbol required' });
  try {
    db.prepare('INSERT OR IGNORE INTO watchlist (user_id, symbol) VALUES (?, ?)').run(req.session.userId, symbol.toUpperCase());
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/watchlist/:symbol', requireAuth, (req, res) => {
  const { symbol } = req.params;
  db.prepare('DELETE FROM watchlist WHERE user_id = ? AND symbol = ?').run(req.session.userId, symbol.toUpperCase());
  res.json({ ok: true });
});

app.get('/api/alerts', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, symbol, direction, price, active, created_at FROM alerts WHERE user_id = ? ORDER BY created_at DESC').all(req.session.userId);
  res.json({ alerts: rows });
});

app.post('/api/alerts', requireAuth, (req, res) => {
  const { symbol, direction, price } = req.body;
  if (!symbol || !direction || typeof price !== 'number') {
    return res.status(400).json({ error: 'Symbol, direction, and numeric price required' });
  }
  if (!['above', 'below'].includes(direction)) {
    return res.status(400).json({ error: 'Direction must be above or below' });
  }
  db.prepare('INSERT INTO alerts (user_id, symbol, direction, price) VALUES (?, ?, ?, ?)').run(
    req.session.userId,
    symbol.toUpperCase(),
    direction,
    price
  );
  res.json({ ok: true });
});

app.delete('/api/alerts/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM alerts WHERE id = ? AND user_id = ?').run(id, req.session.userId);
  res.json({ ok: true });
});

async function alphaGet(params) {
  if (!ALPHA_VANTAGE_API_KEY) {
    throw new Error('Missing ALPHA_VANTAGE_API_KEY');
  }
  const url = 'https://www.alphavantage.co/query';
  const { data } = await axios.get(url, { params: { ...params, apikey: ALPHA_VANTAGE_API_KEY } });
  return data;
}

app.get('/api/search', requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ results: [] });
    const data = await alphaGet({ function: 'SYMBOL_SEARCH', keywords: q });
    const results = (data.bestMatches || []).slice(0, 7).map(m => ({
      symbol: m['1. symbol'],
      name: m['2. name'],
      region: m['4. region'],
      currency: m['8. currency'],
    }));
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: 'Search failed' });
  }
});

app.get('/api/quote', requireAuth, async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').toUpperCase();
    if (!symbol) return res.status(400).json({ error: 'Symbol required' });
    const data = await alphaGet({ function: 'GLOBAL_QUOTE', symbol });
    const q = data['Global Quote'] || {};
    const quote = {
      symbol: q['01. symbol'],
      price: Number(q['05. price']),
      change: Number(q['09. change']),
      changePercent: parseFloat((q['10. change percent'] || '0%').replace('%', '')),
      volume: Number(q['06. volume']),
      latestTradingDay: q['07. latest trading day'],
      previousClose: Number(q['08. previous close']),
      open: Number(q['02. open']),
      high: Number(q['03. high']),
      low: Number(q['04. low']),
    };
    res.json({ quote });
  } catch (e) {
    res.status(500).json({ error: 'Quote failed' });
  }
});

app.get('/api/historic', requireAuth, async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').toUpperCase();
    const interval = String(req.query.interval || 'daily');
    if (!symbol) return res.status(400).json({ error: 'Symbol required' });
    let data = null;
    if (interval === 'intraday') {
      data = await alphaGet({ function: 'TIME_SERIES_INTRADAY', symbol, interval: '5min', outputsize: 'compact' });
      const series = data['Time Series (5min)'] || {};
      const points = Object.entries(series)
        .slice(0, 300)
        .map(([t, o]) => ({ t, close: Number(o['4. close']), volume: Number(o['5. volume']) }))
        .reverse();
      return res.json({ points });
    } else {
      data = await alphaGet({ function: 'TIME_SERIES_DAILY', symbol, outputsize: 'compact' });
      const series = data['Time Series (Daily)'] || {};
      const points = Object.entries(series)
        .slice(0, 100)
        .map(([t, o]) => ({ t, close: Number(o['4. close']), volume: Number(o['5. volume']) }))
        .reverse();
      return res.json({ points });
    }
  } catch (e) {
    res.status(500).json({ error: 'Historic failed' });
  }
});

const clientStreams = new Map();

app.get('/api/stream', requireAuth, (req, res) => {
  const userId = req.session.userId;
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  const sendUpdate = async () => {
    try {
      const rows = db.prepare('SELECT symbol FROM watchlist WHERE user_id = ?').all(userId);
      const symbols = rows.map(r => r.symbol);
      for (const symbol of symbols) {
        try {
          const data = await alphaGet({ function: 'GLOBAL_QUOTE', symbol });
          const q = data['Global Quote'] || {};
          const quote = {
            symbol: q['01. symbol'],
            price: Number(q['05. price']),
            changePercent: parseFloat((q['10. change percent'] || '0%').replace('%', '')),
            time: q['07. latest trading day'],
          };
          res.write(`event: quote\ndata: ${JSON.stringify(quote)}\n\n`);
          const alerts = db.prepare('SELECT id, direction, price FROM alerts WHERE user_id = ? AND symbol = ? AND active = 1').all(userId, symbol);
          for (const a of alerts) {
            if (a.direction === 'above' && quote.price >= a.price) {
              res.write(`event: alert\ndata: ${JSON.stringify({ id: a.id, symbol, message: `${symbol} reached ≥ ${a.price}` })}\n\n`);
              db.prepare('UPDATE alerts SET active = 0 WHERE id = ?').run(a.id);
            } else if (a.direction === 'below' && quote.price <= a.price) {
              res.write(`event: alert\ndata: ${JSON.stringify({ id: a.id, symbol, message: `${symbol} fell ≤ ${a.price}` })}\n\n`);
              db.prepare('UPDATE alerts SET active = 0 WHERE id = ?').run(a.id);
            }
          }
        } catch {}
      }
    } catch {}
  };

  const interval = setInterval(sendUpdate, 15000);
  clientStreams.set(userId, { res, interval });
  req.on('close', () => {
    clearInterval(interval);
    clientStreams.delete(userId);
  });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
