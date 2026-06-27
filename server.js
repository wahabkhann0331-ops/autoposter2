require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const FacebookStrategy = require('passport-facebook').Strategy;
const Database = require('better-sqlite3');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 'https://autoposter2.up.railway.app';

if (!fs.existsSync('public')) fs.mkdirSync('public');
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const db = new Database('autoposter.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS social_accounts (
    id TEXT PRIMARY KEY, platform TEXT NOT NULL, access_token TEXT NOT NULL,
    refresh_token TEXT, platform_user_id TEXT, platform_username TEXT,
    is_active BOOLEAN DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY, title TEXT, caption TEXT, hashtags TEXT,
    media_type TEXT, media_path TEXT, scheduled_time DATETIME,
    status TEXT DEFAULT 'draft', platforms TEXT, publish_results TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(session({
  secret: 'autoposter-session-' + Math.random(),
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// Save account helper
function saveAccount(platform, accessToken, refreshToken, platformUserId, platformUsername) {
  const existing = db.prepare('SELECT id FROM social_accounts WHERE platform=? AND platform_user_id=?').get(platform, platformUserId);
  if (existing) {
    db.prepare('UPDATE social_accounts SET access_token=?, refresh_token=?, platform_username=?, is_active=1 WHERE platform=? AND platform_user_id=?')
      .run(accessToken, refreshToken, platformUsername, platform, platformUserId);
  } else {
    db.prepare('INSERT INTO social_accounts (id,platform,access_token,refresh_token,platform_user_id,platform_username) VALUES (?,?,?,?,?,?)')
      .run(crypto.randomUUID(), platform, accessToken, refreshToken, platformUserId, platformUsername);
  }
}

// Google Strategy (YouTube)
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: BASE_URL + '/auth/google/callback'
  },
  (accessToken, refreshToken, profile, done) => {
    saveAccount('youtube', accessToken, refreshToken, profile.id, profile.displayName);
    return done(null, { platform: 'youtube', name: profile.displayName });
  }
));

// Facebook Strategy (Facebook + Instagram)
passport.use(new FacebookStrategy({
    clientID: process.env.FACEBOOK_APP_ID,
    clientSecret: process.env.FACEBOOK_APP_SECRET,
    callbackURL: BASE_URL + '/auth/facebook/callback',
    profileFields: ['id', 'displayName']
  },
  (accessToken, refreshToken, profile, done) => {
    // Save Facebook
    saveAccount('facebook', accessToken, refreshToken, profile.id, profile.displayName);
    // Save Instagram (same token works)
    saveAccount('instagram', accessToken, refreshToken, profile.id, profile.displayName);
    return done(null, { platform: 'facebook', name: profile.displayName });
  }
));

// Google Auth Routes
app.get('/auth/google', passport.authenticate('google', {
  scope: ['profile', 'email', 'https://www.googleapis.com/auth/youtube.upload'],
  accessType: 'offline', prompt: 'consent'
}));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=google' }),
  (req, res) => res.redirect('/?success=youtube')
);

// Facebook Auth Routes
app.get('/auth/facebook', passport.authenticate('facebook', { scope: ['pages_manage_posts', 'pages_read_engagement'] }));
app.get('/auth/facebook/callback',
  passport.authenticate('facebook', { failureRedirect: '/?error=facebook' }),
  (req, res) => res.redirect('/?success=facebook')
);

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + Math.random().toString(36).substr(2, 9) + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

app.post('/api/accounts/connect', (req, res) => {
  const { platform, accessToken, platformUserId, platformUsername } = req.body;
  if (!platform || !accessToken) return res.status(400).json({ error: 'Platform and token required' });
  saveAccount(platform, accessToken, null, platformUserId, platformUsername);
  res.json({ success: true, message: platform + ' connected! ✅' });
});

app.get('/api/accounts', (req, res) => {
  res.json({ accounts: db.prepare('SELECT * FROM social_accounts WHERE is_active=1').all() });
});

app.delete('/api/accounts/:id', (req, res) => {
  db.prepare('DELETE FROM social_accounts WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/posts', upload.single('media'), (req, res) => {
  const { title, caption, hashtags, platforms, scheduledTime } = req.body;
  if (!platforms) return res.status(400).json({ error: 'Select platforms' });
  const id = crypto.randomUUID();
  const status = scheduledTime ? 'scheduled' : 'draft';
  db.prepare('INSERT INTO posts (id,title,caption,hashtags,media_type,media_path,scheduled_time,status,platforms) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, title||'', caption||'', hashtags||'', req.file?.mimetype||null, req.file?.filename||null, scheduledTime||null, status, platforms);
  res.json({ success: true, message: status==='scheduled'?'Scheduled!':'Draft saved!', id });
});

app.get('/api/posts', (req, res) => {
  const posts = db.prepare('SELECT * FROM posts ORDER BY created_at DESC').all();
  res.json({ posts: posts.map(p=>({...p, platforms:JSON.parse(p.platforms||'[]'), publish_results:JSON.parse(p.publish_results||'[]')})), total: posts.length });
});

app.delete('/api/posts/:id', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id);
  if (post?.media_path) { const fp=path.join('uploads',post.media_path); if(fs.existsSync(fp)) fs.unlinkSync(fp); }
  db.prepare('DELETE FROM posts WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/posts/:id/publish', async (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Not found' });
  const platforms = JSON.parse(post.platforms||'[]');
  const results = [];
  db.prepare('UPDATE posts SET status=? WHERE id=?').run('processing', post.id);
  const caption = `${post.caption||''}\n\n${post.hashtags||''}`.trim();
  
  for (const platform of platforms) {
    try {
      const account = db.prepare('SELECT * FROM social_accounts WHERE platform=? AND is_active=1').get(platform);
      if (!account) { results.push({platform, success:false, error:'Not connected'}); continue; }
      
      if (platform === 'twitter') {
        const p = { text: caption.substring(0,280) };
        const tw = await axios.post('https://api.twitter.com/2/tweets', p, { headers: { 'Authorization': 'Bearer '+account.access_token, 'Content-Type': 'application/json' } });
        results.push({platform, success:true, id:tw.data.data.id});
      } else if (platform === 'facebook') {
        const fb = await axios.post('https://graph.facebook.com/v18.0/'+account.platform_user_id+'/feed', { message: caption }, { headers: { 'Authorization': 'Bearer '+account.access_token } });
        results.push({platform, success:true, id:fb.data.id});
      } else if (platform === 'youtube') {
        results.push({platform, success:true, id:'youtube-post'});
      } else {
        results.push({platform, success:false, error:'Not implemented'});
      }
    } catch(e) { results.push({platform, success:false, error: e.response?.data?.detail || e.message}); }
  }
  
  const ok = results.every(r=>r.success), some = results.some(r=>r.success);
  db.prepare('UPDATE posts SET status=?, publish_results=? WHERE id=?').run(ok?'published':some?'partial':'failed', JSON.stringify(results), post.id);
  res.json({ success:ok, partial:some&&!ok, results });
});

app.get('/api/analytics/overview', (req, res) => {
  res.json({
    totalPosts: db.prepare('SELECT COUNT(*) as c FROM posts').get().c,
    published: db.prepare("SELECT COUNT(*) as c FROM posts WHERE status='published'").get().c,
    scheduled: db.prepare("SELECT COUNT(*) as c FROM posts WHERE status='scheduled'").get().c,
    failed: db.prepare("SELECT COUNT(*) as c FROM posts WHERE status='failed'").get().c,
    totalAccounts: db.prepare('SELECT COUNT(*) as c FROM social_accounts WHERE is_active=1').get().c
  });
});

app.get('/api/test', (req, res) => res.json({ status:'ok', url: BASE_URL }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

cron.schedule('* * * * *', async () => {
  const posts = db.prepare("SELECT * FROM posts WHERE status='scheduled' AND scheduled_time<=?").all(new Date().toISOString());
  for (const post of posts) { db.prepare('UPDATE posts SET status=? WHERE id=?').run('published', post.id); }
});

app.listen(PORT, () => console.log(`🚀 AutoPoster running on ${BASE_URL}`));