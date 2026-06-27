require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Folders
if (!fs.existsSync('public')) fs.mkdirSync('public');
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// Database
const db = new Database('autoposter.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS social_accounts (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    platform_user_id TEXT,
    platform_username TEXT,
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    title TEXT,
    caption TEXT,
    hashtags TEXT,
    media_type TEXT,
    media_path TEXT,
    scheduled_time DATETIME,
    status TEXT DEFAULT 'draft',
    platforms TEXT,
    publish_results TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// File upload
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + Math.random().toString(36).substr(2, 9) + ext);
  }
});
const upload = multer({ 
  storage, 
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|mp4|mov|avi|webm|mkv/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    if (ext && mime) cb(null, true);
    else cb(new Error('Only images and videos allowed'));
  }
});

// ==================== ACCOUNTS ====================
app.post('/api/accounts/connect', (req, res) => {
  try {
    const { platform, accessToken, refreshToken, platformUserId, platformUsername } = req.body;
    
    if (!platform) return res.status(400).json({ error: 'Platform is required' });
    if (!accessToken) return res.status(400).json({ error: 'Access token is required' });
    if (!platformUserId) return res.status(400).json({ error: 'User/Page ID is required' });
    
    const existing = db.prepare('SELECT id FROM social_accounts WHERE platform = ?').get(platform);
    
    if (existing) {
      db.prepare('UPDATE social_accounts SET access_token = ?, refresh_token = ?, platform_user_id = ?, platform_username = ?, is_active = 1 WHERE platform = ?')
        .run(accessToken, refreshToken || null, platformUserId, platformUsername || '', platform);
    } else {
      const id = crypto.randomUUID();
      db.prepare('INSERT INTO social_accounts (id, platform, access_token, refresh_token, platform_user_id, platform_username) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, platform, accessToken, refreshToken || null, platformUserId, platformUsername || '');
    }
    
    console.log(`✅ ${platform} account connected!`);
    res.json({ success: true, message: `${platform} connected successfully! ✅` });
  } catch (error) {
    console.error('Connect error:', error);
    res.status(500).json({ error: 'Connection failed: ' + error.message });
  }
});

app.get('/api/accounts', (req, res) => {
  try {
    const accounts = db.prepare('SELECT * FROM social_accounts WHERE is_active = 1').all();
    res.json({ accounts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/accounts/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM social_accounts WHERE id = ?').run(req.params.id);
    res.json({ success: true, message: 'Account removed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== POSTS ====================
app.post('/api/posts', upload.single('media'), (req, res) => {
  try {
    const { title, caption, hashtags, platforms, scheduledTime } = req.body;
    
    if (!platforms) return res.status(400).json({ error: 'Select at least one platform' });
    
    let parsedPlatforms;
    try {
      parsedPlatforms = JSON.parse(platforms);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid platforms format' });
    }
    
    if (!parsedPlatforms.length) return res.status(400).json({ error: 'Select at least one platform' });
    
    const id = crypto.randomUUID();
    const status = scheduledTime ? 'scheduled' : 'draft';
    
    db.prepare('INSERT INTO posts (id, title, caption, hashtags, media_type, media_path, scheduled_time, status, platforms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, title || '', caption || '', hashtags || '', req.file?.mimetype || null, req.file?.filename || null, scheduledTime || null, status, platforms);
    
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
    
    res.status(201).json({
      success: true,
      message: scheduledTime ? 'Post scheduled! ⏰ Will publish at: ' + new Date(scheduledTime).toLocaleString() : 'Draft saved! 📝 Click Publish Now to post.',
      post: { ...post, platforms: parsedPlatforms, publish_results: [] }
    });
  } catch (error) {
    console.error('Create post error:', error);
    res.status(500).json({ error: 'Failed to create post: ' + error.message });
  }
});

app.get('/api/posts', (req, res) => {
  try {
    const { status } = req.query;
    let query = 'SELECT * FROM posts WHERE 1=1';
    const params = [];
    
    if (status) {
      query += ' AND status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY created_at DESC';
    const posts = db.prepare(query).all(...params);
    const total = db.prepare('SELECT COUNT(*) as count FROM posts').get();
    
    res.json({
      posts: posts.map(p => ({
        ...p,
        platforms: JSON.parse(p.platforms || '[]'),
        publish_results: JSON.parse(p.publish_results || '[]')
      })),
      total: total.count
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/posts/:id', upload.single('media'), (req, res) => {
  try {
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    
    const { title, caption, hashtags, platforms, scheduledTime } = req.body;
    
    db.prepare('UPDATE posts SET title = ?, caption = ?, hashtags = ?, scheduled_time = ?, platforms = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(title || post.title, caption || post.caption, hashtags || post.hashtags, scheduledTime || post.scheduled_time, platforms || post.platforms, post.id);
    
    res.json({ success: true, message: 'Post updated! ✅' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/posts/:id', (req, res) => {
  try {
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    
    if (post.media_path) {
      const fp = path.join('uploads', post.media_path);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    
    db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
    res.json({ success: true, message: 'Post deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== PUBLISH ====================
app.post('/api/posts/:id/publish', async (req, res) => {
  try {
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.status === 'processing') return res.status(400).json({ error: 'Already publishing' });
    
    const platforms = JSON.parse(post.platforms || '[]');
    if (!platforms.length) return res.status(400).json({ error: 'No platforms selected' });
    
    db.prepare('UPDATE posts SET status = ? WHERE id = ?').run('processing', post.id);
    
    const results = [];
    const caption = `${post.caption || ''}\n\n${post.hashtags || ''}`.trim();
    
    for (const platform of platforms) {
      try {
        const account = db.prepare('SELECT * FROM social_accounts WHERE platform = ? AND is_active = 1').get(platform);
        if (!account) {
          results.push({ platform, success: false, error: 'Account not connected' });
          continue;
        }
        
        let result;
        
        switch (platform) {
          case 'twitter':
            const twPayload = { text: caption.substring(0, 280) };
            if (post.media_path && fs.existsSync(path.join('uploads', post.media_path))) {
              const FormData = require('form-data');
              const mediaForm = new FormData();
              mediaForm.append('media', fs.createReadStream(path.join('uploads', post.media_path)));
              const mediaUpload = await axios.post('https://upload.twitter.com/1.1/media/upload.json', mediaForm, {
                headers: { 'Authorization': `Bearer ${account.access_token}`, ...mediaForm.getHeaders() }
              });
              twPayload.media = { media_ids: [mediaUpload.data.media_id_string] };
            }
            const twRes = await axios.post('https://api.twitter.com/2/tweets', twPayload, {
              headers: { 'Authorization': `Bearer ${account.access_token}`, 'Content-Type': 'application/json' }
            });
            result = { platform, success: true, id: twRes.data.data.id, url: `https://twitter.com/i/web/status/${twRes.data.data.id}` };
            break;
            
          case 'facebook':
            if (post.media_path && fs.existsSync(path.join('uploads', post.media_path))) {
              const FormData = require('form-data');
              const fbForm = new FormData();
              fbForm.append('source', fs.createReadStream(path.join('uploads', post.media_path)));
              fbForm.append('message', caption);
              const fbRes = await axios.post(`https://graph.facebook.com/v18.0/${account.platform_user_id}/photos`, fbForm, {
                headers: { 'Authorization': `Bearer ${account.access_token}`, ...fbForm.getHeaders() }
              });
              result = { platform, success: true, id: fbRes.data.id };
            } else {
              const fbRes = await axios.post(`https://graph.facebook.com/v18.0/${account.platform_user_id}/feed`, 
                { message: caption }, 
                { headers: { 'Authorization': `Bearer ${account.access_token}` } }
              );
              result = { platform, success: true, id: fbRes.data.id };
            }
            break;
            
          case 'instagram':
            if (!post.media_path) throw new Error('Media required for Instagram');
            const isVideo = /\.(mp4|mov|avi|webm|mkv)$/i.test(post.media_path);
            const mediaUrl = `${BASE_URL}/uploads/${post.media_path}`;
            const containerRes = await axios.post(`https://graph.facebook.com/v18.0/${account.platform_user_id}/media`, {
              [isVideo ? 'video_url' : 'image_url']: mediaUrl,
              caption,
              media_type: isVideo ? 'VIDEO' : 'IMAGE'
            }, { headers: { 'Authorization': `Bearer ${account.access_token}` } });
            
            let ready = false, attempts = 0;
            while (!ready && attempts < 30) {
              await new Promise(r => setTimeout(r, 3000));
              const statusRes = await axios.get(`https://graph.facebook.com/v18.0/${containerRes.data.id}?fields=status_code`, {
                headers: { 'Authorization': `Bearer ${account.access_token}` }
              });
              if (statusRes.data.status_code === 'FINISHED') ready = true;
              else if (statusRes.data.status_code === 'ERROR') throw new Error('Instagram processing failed');
              attempts++;
            }
            
            const pubRes = await axios.post(`https://graph.facebook.com/v18.0/${account.platform_user_id}/media_publish`, 
              { creation_id: containerRes.data.id },
              { headers: { 'Authorization': `Bearer ${account.access_token}` } }
            );
            result = { platform, success: true, id: pubRes.data.id };
            break;
            
          case 'linkedin':
            const liRes = await axios.post('https://api.linkedin.com/v2/ugcPosts', {
              author: `urn:li:person:${account.platform_user_id}`,
              lifecycleState: 'PUBLISHED',
              specificContent: { 'com.linkedin.ugc.ShareContent': { shareCommentary: { text: caption }, shareMediaCategory: 'NONE' } },
              visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
            }, {
              headers: { 'Authorization': `Bearer ${account.access_token}`, 'Content-Type': 'application/json', 'X-Restli-Protocol-Version': '2.0.0' }
            });
            result = { platform, success: true, id: liRes.data.id };
            break;
            
          case 'youtube':
            if (!post.media_path) throw new Error('Video required for YouTube');
            if (!fs.existsSync(path.join('uploads', post.media_path))) throw new Error('Video file not found');
            
            const FormData = require('form-data');
            const ytForm = new FormData();
            ytForm.append('metadata', JSON.stringify({
              snippet: { title: (post.title || caption).substring(0, 100), description: caption + '\n\n#Shorts', categoryId: '22' },
              status: { privacyStatus: 'public', selfDeclaredMadeForKids: false }
            }), { contentType: 'application/json' });
            ytForm.append('media', fs.createReadStream(path.join('uploads', post.media_path)));
            
            const ytRes = await axios.post('https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status', ytForm, {
              headers: { 'Authorization': `Bearer ${account.access_token}`, ...ytForm.getHeaders() },
              maxContentLength: Infinity,
              maxBodyLength: Infinity
            });
            result = { platform, success: true, id: ytRes.data.id, url: `https://youtube.com/watch?v=${ytRes.data.id}` };
            break;
            
          default:
            result = { platform, success: false, error: 'Platform not supported yet' };
        }
        
        results.push(result);
      } catch (error) {
        console.error(`${platform} publish error:`, error.response?.data || error.message);
        results.push({
          platform,
          success: false,
          error: error.response?.data?.detail || error.response?.data?.error?.message || error.message
        });
      }
    }
    
    const allOk = results.every(r => r.success);
    const someOk = results.some(r => r.success);
    const finalStatus = allOk ? 'published' : someOk ? 'partial' : 'failed';
    
    db.prepare('UPDATE posts SET status = ?, publish_results = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(finalStatus, JSON.stringify(results), post.id);
    
    // Cleanup media after 10 minutes
    if (post.media_path) {
      setTimeout(() => {
        const fp = path.join('uploads', post.media_path);
        if (fs.existsSync(fp)) {
          fs.unlinkSync(fp);
          db.prepare('UPDATE posts SET media_path = NULL WHERE id = ?').run(post.id);
        }
      }, 10 * 60 * 1000);
    }
    
    res.json({ success: allOk, partial: someOk && !allOk, status: finalStatus, results });
  } catch (error) {
    console.error('Publish error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== ANALYTICS ====================
app.get('/api/analytics/overview', (req, res) => {
  try {
    const stats = {
      totalPosts: db.prepare('SELECT COUNT(*) as count FROM posts').get().count,
      published: db.prepare("SELECT COUNT(*) as count FROM posts WHERE status = 'published'").get().count,
      scheduled: db.prepare("SELECT COUNT(*) as count FROM posts WHERE status = 'scheduled'").get().count,
      failed: db.prepare("SELECT COUNT(*) as count FROM posts WHERE status = 'failed'").get().count,
      totalAccounts: db.prepare('SELECT COUNT(*) as count FROM social_accounts WHERE is_active = 1').get().count
    };
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== TOKEN VERIFY ====================
app.post('/api/verify-token', async (req, res) => {
  const { platform, token } = req.body;
  try {
    if (platform === 'twitter') {
      const tw = await axios.get('https://api.twitter.com/2/users/me', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      res.json({ valid: true, username: tw.data.data.username, id: tw.data.data.id });
    } else if (platform === 'facebook') {
      const fb = await axios.get('https://graph.facebook.com/v18.0/me', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      res.json({ valid: true, name: fb.data.name, id: fb.data.id });
    } else if (platform === 'linkedin') {
      const li = await axios.get('https://api.linkedin.com/v2/userinfo', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      res.json({ valid: true, name: li.data.name, id: li.data.sub });
    } else {
      res.json({ valid: false, error: 'Cannot verify this platform' });
    }
  } catch (error) {
    res.json({ valid: false, error: 'Invalid token' });
  }
});

// ==================== HEALTH CHECK ====================
app.get('/api/test', (req, res) => {
  res.json({ status: 'ok', message: 'AutoPoster API is running! 🚀', timestamp: new Date().toISOString() });
});

// ==================== HOME PAGE ====================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
  console.log(`🚀 AutoPoster Server Running!`);
  console.log(`📱 URL: ${BASE_URL}`);
  console.log(`🔌 API: ${BASE_URL}/api`);
  console.log(`❤️  Health: ${BASE_URL}/api/test`);
});