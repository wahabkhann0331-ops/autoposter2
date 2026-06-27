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

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: BASE_URL + '/auth/google/callback'
  },
  (accessToken, refreshToken, profile, done) => {
    const existing = db.prepare('SELECT id FROM social_accounts WHERE platform=? AND platform_user_id=?').get('youtube', profile.id);
    if (existing) {
      db.prepare('UPDATE social_accounts SET access_token=?, refresh_token=?, platform_username=?, is_active=1 WHERE platform=? AND platform_user_id=?')
        .run(accessToken, refreshToken, profile.displayName, 'youtube', profile.id);
    } else {
      db.prepare('INSERT INTO social_accounts (id,platform,access_token,refresh_token,platform_user_id,platform_username) VALUES (?,?,?,?,?,?)')
        .run(crypto.randomUUID(), 'youtube', accessToken, refreshToken, profile.id, profile.displayName);
    }
    return done(null, { platform: 'youtube', name: profile.displayName });
  }
));

const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + Math.random().toString(36).substr(2, 9) + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

app.get('/auth/google', passport.authenticate('google', {
  scope: ['profile', 'email', 'https://www.googleapis.com/auth/youtube.upload'],
  accessType: 'offline',
  prompt: 'consent'
}));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=google' }),
  (req, res) => res.redirect('/?success=youtube')
);

app.post('/api/accounts/connect', (req, res) => {
  const { platform, accessToken, refreshToken, platformUserId, platformUsername } = req.body;
  if (!platform || !accessToken || !platformUserId) return res.status(400).json({ error: 'Platform, token and ID required' });
  const existing = db.prepare('SELECT id FROM social_accounts WHERE platform = ?').get(platform);
  if (existing) {
    db.prepare('UPDATE social_accounts SET access_token=?, refresh_token=?, platform_user_id=?, platform_username=?, is_active=1 WHERE platform=?')
      .run(accessToken, refreshToken||null, platformUserId, platformUsername||'', platform);
  } else {
    db.prepare('INSERT INTO social_accounts (id,platform,access_token,refresh_token,platform_user_id,platform_username) VALUES (?,?,?,?,?,?)')
      .run(crypto.randomUUID(), platform, accessToken, refreshToken||null, platformUserId, platformUsername||'');
  }
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
  res.json({ success: true, message: status==='scheduled'?'Scheduled! ⏰':'Draft saved! 📝', id });
});

app.get('/api/posts', (req, res) => {
  const posts = db.prepare('SELECT * FROM posts ORDER BY created_at DESC').all();
  const total = db.prepare('SELECT COUNT(*) as c FROM posts').get();
  res.json({ posts: posts.map(p=>({...p, platforms:JSON.parse(p.platforms||'[]'), publish_results:JSON.parse(p.publish_results||'[]')})), total: total.c });
});

app.put('/api/posts/:id', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id=?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Not found' });
  const { title, caption, hashtags, platforms, scheduledTime } = req.body;
  db.prepare('UPDATE posts SET title=?, caption=?, hashtags=?, scheduled_time=?, platforms=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(title||post.title, caption||post.caption, hashtags||post.hashtags, scheduledTime||post.scheduled_time, platforms||post.platforms, post.id);
  res.json({ success: true, message: 'Updated! ✅' });
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
      
      let result;
      switch(platform) {
        case 'twitter':
          const p = { text: caption.substring(0,280) };
          if (post.media_path) {
            const FormData = require('form-data');
            const mf = new FormData();
            mf.append('media', fs.createReadStream(path.join('uploads',post.media_path)));
            const mu = await axios.post('https://upload.twitter.com/1.1/media/upload.json', mf, { headers: { 'Authorization': `Bearer ${account.access_token}`, ...mf.getHeaders() } });
            p.media = { media_ids: [mu.data.media_id_string] };
          }
          const tw = await axios.post('https://api.twitter.com/2/tweets', p, { headers: { 'Authorization': `Bearer ${account.access_token}`, 'Content-Type': 'application/json' } });
          result = { platform, success:true, id:tw.data.data.id };
          break;
        case 'facebook':
          if (post.media_path) {
            const FormData = require('form-data');
            const ff = new FormData();
            ff.append('source', fs.createReadStream(path.join('uploads',post.media_path)));
            ff.append('message', caption);
            const fb = await axios.post(`https://graph.facebook.com/v18.0/${account.platform_user_id}/photos`, ff, { headers: { 'Authorization': `Bearer ${account.access_token}`, ...ff.getHeaders() } });
            result = { platform, success:true, id:fb.data.id };
          } else {
            const fb = await axios.post(`https://graph.facebook.com/v18.0/${account.platform_user_id}/feed`, { message: caption }, { headers: { 'Authorization': `Bearer ${account.access_token}` } });
            result = { platform, success:true, id:fb.data.id };
          }
          break;
        case 'instagram':
          if (!post.media_path) throw new Error('Media required');
          const isVid = /\.(mp4|mov|avi)$/i.test(post.media_path);
          const cont = await axios.post(`https://graph.facebook.com/v18.0/${account.platform_user_id}/media`, {
            [isVid?'video_url':'image_url']: `${BASE_URL}/uploads/${post.media_path}`, caption, media_type: isVid?'VIDEO':'IMAGE'
          }, { headers: { 'Authorization': `Bearer ${account.access_token}` } });
          let ready=false, att=0;
          while(!ready&&att<30){await new Promise(r=>setTimeout(r,3000));const s=await axios.get(`https://graph.facebook.com/v18.0/${cont.data.id}?fields=status_code`,{headers:{'Authorization':`Bearer ${account.access_token}`}});if(s.data.status_code==='FINISHED')ready=true;att++}
          const pub = await axios.post(`https://graph.facebook.com/v18.0/${account.platform_user_id}/media_publish`, { creation_id: cont.data.id }, { headers: { 'Authorization': `Bearer ${account.access_token}` } });
          result = { platform, success:true, id:pub.data.id };
          break;
        case 'linkedin':
          const li = await axios.post('https://api.linkedin.com/v2/ugcPosts', {
            author: `urn:li:person:${account.platform_user_id}`, lifecycleState: 'PUBLISHED',
            specificContent: {'com.linkedin.ugc.ShareContent': { shareCommentary: { text: caption }, shareMediaCategory: 'NONE' }},
            visibility: {'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC'}
          }, { headers: { 'Authorization': `Bearer ${account.access_token}`, 'Content-Type': 'application/json', 'X-Restli-Protocol-Version': '2.0.0' } });
          result = { platform, success:true, id:li.data.id };
          break;
        case 'youtube':
          if (!post.media_path) throw new Error('Video required');
          const FormData = require('form-data');
          const yf = new FormData();
          yf.append('metadata', JSON.stringify({ snippet: { title: (post.title||caption).substring(0,100), description: caption+'\n\n#Shorts', categoryId: '22' }, status: { privacyStatus: 'public', selfDeclaredMadeForKids: false } }), { contentType: 'application/json' });
          yf.append('media', fs.createReadStream(path.join('uploads',post.media_path)));
          const yt = await axios.post('https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status', yf, { headers: { 'Authorization': `Bearer ${account.access_token}`, ...yf.getHeaders() }, maxContentLength: Infinity, maxBodyLength: Infinity });
          result = { platform, success:true, id:yt.data.id };
          break;
        default:
          result = { platform, success:false, error:'Not implemented' };
      }
      results.push(result);
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
