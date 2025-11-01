const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
app.use(express.json());

// Koneksi MongoDB Atlas (GRATIS)
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://username:password@cluster0.mongodb.net/playstore-monitor?retryWrites=true&w=majority';

mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
});

// Schema untuk aplikasi
const appSchema = new mongoose.Schema({
    appId: { type: String, required: true, unique: true },
    appUrl: { type: String, required: true },
    status: { type: String, default: 'active' }, // active, removed, notified
    lastChecked: { type: Date, default: Date.now },
    notificationSent: { type: Date },
    checkCount: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});

// Schema untuk konfigurasi
const configSchema = new mongoose.Schema({
    telegramBotToken: String,
    telegramChatId: String,
    checkInterval: { type: Number, default: 60 } // detik
});

// Schema untuk log
const logSchema = new mongoose.Schema({
    message: String,
    type: String, // info, success, warning, error
    timestamp: { type: Date, default: Date.now }
});

const App = mongoose.model('App', appSchema);
const Config = mongoose.model('Config', configSchema);
const Log = mongoose.model('Log', logSchema);

// ==================== API ROUTES ====================

// Get semua aplikasi
app.get('/api/apps', async (req, res) => {
    try {
        const apps = await App.find().sort({ createdAt: -1 });
        res.json(apps);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Tambah aplikasi
app.post('/api/apps', async (req, res) => {
    try {
        const { appId, appUrl } = req.body;
        
        // Validasi URL
        if (!appUrl.includes('play.google.com')) {
            return res.status(400).json({ error: 'URL harus mengarah ke Google Play Store' });
        }
        
        const app = new App({ appId, appUrl });
        await app.save();
        
        // Log
        await Log.create({
            message: `Aplikasi ${appId} ditambahkan ke monitoring`,
            type: 'info'
        });
        
        res.json(app);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Hapus aplikasi
app.delete('/api/apps/:appId', async (req, res) => {
    try {
        await App.findOneAndDelete({ appId: req.params.appId });
        
        await Log.create({
            message: `Aplikasi ${req.params.appId} dihapus dari monitoring`,
            type: 'info'
        });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get/save konfigurasi
app.get('/api/config', async (req, res) => {
    try {
        let config = await Config.findOne();
        if (!config) {
            config = new Config();
            await config.save();
        }
        res.json(config);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/config', async (req, res) => {
    try {
        const { telegramBotToken, telegramChatId } = req.body;
        let config = await Config.findOne();
        
        if (!config) {
            config = new Config({ telegramBotToken, telegramChatId });
        } else {
            config.telegramBotToken = telegramBotToken;
            config.telegramChatId = telegramChatId;
        }
        
        await config.save();
        
        await Log.create({
            message: 'Konfigurasi bot Telegram diperbarui',
            type: 'success'
        });
        
        res.json(config);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Test bot
app.post('/api/test-bot', async (req, res) => {
    try {
        const config = await Config.findOne();
        
        if (!config || !config.telegramBotToken || !config.telegramChatId) {
            return res.status(400).json({ error: 'Bot Telegram belum dikonfigurasi' });
        }
        
        const message = '✅ Test notifikasi dari Play Store Monitor 24/7!\n\nBot berhasil dikonfigurasi dan siap mengirim notifikasi ketika aplikasi dihapus dari Play Store.\n\n⏰ Waktu: ' + new Date().toLocaleString('id-ID');
        
        await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, message);
        
        await Log.create({
            message: 'Pesan test berhasil dikirim ke Telegram',
            type: 'success'
        });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get statistics
app.get('/api/stats', async (req, res) => {
    try {
        const totalApps = await App.countDocuments();
        const activeApps = await App.countDocuments({ status: 'active' });
        const removedApps = await App.countDocuments({ status: { $in: ['removed', 'notified'] } });
        
        const lastLog = await Log.findOne().sort({ timestamp: -1 });
        
        res.json({
            totalApps,
            activeApps,
            removedApps,
            notificationsSent: await App.countDocuments({ notificationSent: { $ne: null } }),
            lastCheck: lastLog?.timestamp
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== MONITORING SERVICE ====================

// Fungsi untuk cek status aplikasi
async function checkAppStatus(app) {
    try {
        const proxyUrl = 'https://api.allorigins.win/raw?url=';
        const targetUrl = encodeURIComponent(app.appUrl);
        
        const response = await axios.get(proxyUrl + targetUrl, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        const html = response.data;
        const titleMatch = html.match(/<title>(.*?)<\/title>/i);
        const pageTitle = titleMatch && titleMatch[1] ? titleMatch[1].trim() : '';
        
        app.lastChecked = new Date();
        app.checkCount += 1;
        
        // LOGIC DETEKSI: Jika title = "Not Found" → dihapus
        if (pageTitle === 'Not Found') {
            if (app.status === 'active') {
                app.status = 'removed';
                
                // Kirim notifikasi Telegram
                const config = await Config.findOne();
                if (config && config.telegramBotToken && config.telegramChatId) {
                    const timestamp = new Date().toLocaleString('id-ID');
                    const message = `🚨 PERINGATAN! Aplikasi ${app.appId} telah dihapus dari Google Play Store!\n\n📱 ID Package: ${app.appId}\n🔗 URL: ${app.appUrl}\n\n⏰ Waktu: ${timestamp}\n\nSilakan periksa aplikasi ini untuk tindakan lebih lanjut.`;
                    
                    await sendTelegramMessage(config.telegramBotToken, config.telegramChatId, message);
                    
                    app.notificationSent = new Date();
                    app.status = 'notified';
                    
                    await Log.create({
                        message: `Notifikasi dikirim: Aplikasi ${app.appId} dihapus dari Play Store`,
                        type: 'warning'
                    });
                }
            }
        } else {
            app.status = 'active';
        }
        
        await app.save();
        
    } catch (error) {
        console.error(`Error checking app ${app.appId}:`, error.message);
        await Log.create({
            message: `Gagal memeriksa aplikasi ${app.appId}: ${error.message}`,
            type: 'error'
        });
    }
}

// Fungsi kirim pesan Telegram
async function sendTelegramMessage(botToken, chatId, message) {
    try {
        const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
        
        await axios.post(url, {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML'
        });
        
        return true;
    } catch (error) {
        console.error('Error sending Telegram message:', error.message);
        await Log.create({
            message: `Gagal mengirim notifikasi Telegram: ${error.message}`,
            type: 'error'
        });
        return false;
    }
}

// ==================== CRON JOB ====================

// Jalankan pengecekan setiap 60 detik
cron.schedule('*/1 * * * *', async () => {
    try {
        const activeApps = await App.find({ status: 'active' });
        const config = await Config.findOne();
        const checkInterval = config?.checkInterval || 60;
        
        // Cek apakah sudah waktunya melakukan pengecekan
        const now = new Date();
        const shouldCheck = activeApps.some(app => {
            const lastChecked = new Date(app.lastChecked);
            const diffSeconds = (now - lastChecked) / 1000;
            return diffSeconds >= checkInterval;
        });
        
        if (shouldCheck && activeApps.length > 0) {
            await Log.create({
                message: `Memulai pengecekan ${activeApps.length} aplikasi aktif`,
                type: 'info'
            });
            
            // Check apps sequentially dengan delay
            for (let i = 0; i < activeApps.length; i++) {
                await checkAppStatus(activeApps[i]);
                
                // Delay 2 detik antara pengecekan untuk menghindari rate limit
                if (i < activeApps.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
            
            await Log.create({
                message: `Pengecekan ${activeApps.length} aplikasi selesai`,
                type: 'success'
            });
        }
    } catch (error) {
        console.error('Error in monitoring cron job:', error);
        await Log.create({
            message: `Error dalam cron job: ${error.message}`,
            type: 'error'
        });
    }
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server monitoring 24/7 berjalan di port ${PORT}`);
    console.log(`✅ Monitoring aktif: Setiap 60 detik`);
    console.log(`📊 Dashboard: http://localhost:${PORT}/index.html`);
});
