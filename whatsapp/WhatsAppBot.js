/**
 * WhatsAppBot.js — HALEEM Server Edition
 * QR login + Ollama auto-reply + Knowledge Base + Image sending
 * NO social media publishing.
 */

'use strict';

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const path = require('path');
const fs = require('fs-extra');
const QRCode = require('qrcode');
const OllamaBridge = require('./OllamaBridge');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.haleem-server');
const WA_SESSIONS_DIR = path.join(DATA_DIR, 'wa_sessions');
const KB_PATH = path.join(DATA_DIR, 'wa_knowledge_base.json');
const DEFAULT_SYS_PROMPT = 'أنت مساعد ذكي لحساب HALEEM. رد بأفضل رد مناسب ومختصر وودي باللغة العربية. لا تذكر أنك ذكاء اصطناعي. كن طبيعياً. إذا أرسل العميل إيموجي أو ستيكر رد بشكل لطيف ومناسب.';

const MEDIA_DIR = path.join(DATA_DIR, 'media');
const APP_MEDIA_DIR = path.join(__dirname, '..', 'media');
const INSTALL_VIDEO_PATH = fs.existsSync(path.join(APP_MEDIA_DIR, 'install_guide.mp4'))
    ? path.join(APP_MEDIA_DIR, 'install_guide.mp4')
    : path.join(MEDIA_DIR, 'install_guide.mp4');

const DOWNLOAD_KEYWORDS = ['تحميل', 'تنزيل', 'download', 'install', 'اريد البلجن', 'عايز البلجن', 'ابي البلجن', 'ابغى البلجن', 'كيف احمل', 'كيف انزل', 'طريقة التثبيت', 'طريقة التحميل'];

const INSTALL_GUIDE_TEXT = `دي طريقة التثبيت والتنشيط ولكن الشرح كامل في الفيديو علي :

فيس بوك:
https://www.facebook.com/share/v/1D4Lwtk19i/
يوتيوب:
https://youtu.be/ADhj1aeGcW8?si=8eQqzDaiTm2eIrYA
تيك توك:
https://vm.tiktok.com/ZNRvQKBT1/


تثبيت بلجن HALEEM-ULTRA سهل جداً، فقط اتبع الخطوات التالية بالترتيب:

1. أولاً، قم بتحميل برنامج Ollama من الرابط التالي وثبّته على جهازك:
https://ollama.com/
2. افتح إعدادات Ollama وسجّل دخولك باستخدام حساب Gmail الخاص بك.
3. انتقل إلى رابط البلجن التالي:
https://github.com/haleemrz/HALEEM-Releases/releases
4. قم بنسخ "سكريبت التحميل" الموجود في الصفحة.
5. افتح برنامج PowerShell على جهازك كمسؤول (Run as Administrator).
6. الصق السكريبت الذي نسخته واضغط Enter.
7. انتظر قليلاً حتى ينتهي PowerShell من عملية التثبيت بالكامل.
8. الآن افتح برنامج أدوبي بريمير، وستجد البلجن جاهزة للعمل!

*ملاحظة هامة:* البلجن تعمل على إصدار Premiere Pro 2024 وما بعده. إذا كان إصدارك قديماً، يمكنك تحميل نسخة حديثة من هنا:
https://drive.google.com/drive/folders/1Gmi3Qu9HrPcVIYleKiFjqzzfQeCTdKgZ?usp=sharing
(وننصحك بتحميل إصدار 2025 إذا كان جهازك ضعيفاً لأنها تعمل بكفاءة أعلى).

بعد أن تثبت البلجن ستعمل معك مدة تجريبية لمدة ساعتين؛ بعد أن تجرب البلجن عد مجددا الي هنا وأخبرني "اريد الشراء أو اريد الدفع أو عايز اشتري" ويرجي عدم طلب الشراء قبل التحميل والتجربة والرضاء بالمنتج أولاً.`;

function isValidName(name) {
    if (!name) return false;
    name = name.trim();
    if (name.length < 3) return false;
    const excludes = ['هاي', 'هلو', 'سلام', 'مرحبا', 'هلا', 'hi', 'hello', 'hey', 'ok', 'نعم', 'لا', 'تمام', 'شكرا', 'ثواني', 'انا', 'أنا'];
    if (excludes.includes(name.toLowerCase())) return false;
    const nameRegex = /^[a-zA-Z\s\u0600-\u06FF]+$/;
    return nameRegex.test(name);
}

function isValidPhone(phone) {
    if (!phone) return false;
    const clean = phone.replace(/[\s\-\(\)\+]/g, '');
    if (clean.length < 7 || clean.length > 15) return false;
    const phoneRegex = /^[0-9]+$/;
    return phoneRegex.test(clean);
}

class WhatsAppBot {
    constructor(sendLog, sendQR, sendStatus) {
        this.client = null;
        this.status = 'disconnected';
        this.sendLog = sendLog || console.log;
        this.sendQR = sendQR || function() {};
        this.sendStatus = sendStatus || function() {};
        this.ollama = new OllamaBridge();
        this._repliedMsgIds = new Set();
        this._knowledgeBase = [];
        this._systemPrompt = DEFAULT_SYS_PROMPT;
        this._ollamaModel = 'gemma4:31b-cloud';
        this._chatStates = new Map();
        this._sentInstallGuide = new Set();
        this._chatLocks = new Set(); // per-chat processing lock
        this._createKeyFn = null;
        this._getTunnelUrlFn = null;
        fs.ensureDirSync(WA_SESSIONS_DIR);
        fs.ensureDirSync(MEDIA_DIR);
        this._loadKB();
    }

    // ─── Knowledge Base ──────────────────────────────────
    _loadKB() {
        try {
            if (fs.existsSync(KB_PATH)) {
                const raw = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
                if (raw && raw.items) {
                    this._knowledgeBase = raw.items;
                    this._systemPrompt = raw.systemPrompt || DEFAULT_SYS_PROMPT;
                    this._ollamaModel = raw.ollamaModel || 'gemma4:31b-cloud';
                } else if (Array.isArray(raw)) {
                    this._knowledgeBase = raw;
                }
                this.sendLog('[WhatsApp] 📚 تم تحميل ' + this._knowledgeBase.length + ' عنصر من قاعدة البيانات. النموذج: ' + this._ollamaModel);
            }
        } catch (e) {
            this.sendLog('[WhatsApp] ⚠️ فشل تحميل قاعدة البيانات: ' + e.message);
        }
    }

    saveKB(data) {
        if (data && data.items) {
            this._knowledgeBase = data.items;
            this._systemPrompt = data.systemPrompt || DEFAULT_SYS_PROMPT;
            this._ollamaModel = data.ollamaModel || 'gemma4:31b-cloud';
        } else if (Array.isArray(data)) {
            this._knowledgeBase = data;
        }
        fs.writeFileSync(KB_PATH, JSON.stringify(data, null, 2), 'utf8');
        this.sendLog('[WhatsApp] 💾 تم حفظ قاعدة البيانات: ' + this._knowledgeBase.length + ' عنصر');
    }

    getKB() {
        this._loadKB();
        return { systemPrompt: this._systemPrompt, items: this._knowledgeBase, ollamaModel: this._ollamaModel };
    }

    // ─── Connect ─────────────────────────────────────────
    async connect() {
        if (this.client && this.status === 'ready') {
            return { success: true, status: 'already_connected' };
        }

        this.sendLog('[WhatsApp] 📱 جاري تهيئة واتساب...');
        this._updateStatus('initializing');

        this.client = new Client({
            authStrategy: new LocalAuth({ clientId: 'haleem_server', dataPath: WA_SESSIONS_DIR }),
            puppeteer: { 
                headless: true, 
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
                protocolTimeout: 180000 // 3 minutes timeout for CPU-only / slow servers
            }
        });

        this.client.on('qr', async (qr) => {
            this.status = 'waiting_qr';
            this._updateStatus('waiting_qr');
            this.sendLog('[WhatsApp] 📸 QR Code جاهز — امسح الكود من هاتفك.');
            try {
                const qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
                this.sendQR(qrDataUrl);
                // Print QR as ASCII art to console for headless servers (visible via journalctl)
                const qrText = await QRCode.toString(qr, { type: 'terminal', small: true });
                console.log('\n====== SCAN THIS QR CODE ======\n' + qrText + '===============================\n');
            } catch (e) {
                this.sendLog('[WhatsApp] ⚠️ خطأ في توليد QR: ' + e.message);
            }
        });

        this.client.on('ready', async () => {
            this.status = 'ready';
            this._updateStatus('ready');
            this.sendLog('[WhatsApp] ✅ واتساب متصل بنجاح!');
            this.sendQR(null);
            this._replyToOldUnread();
        });

        // Use 'message' event (incoming only) instead of 'message_create' (all messages)
        // to prevent processing our own outgoing messages and avoid duplicate replies
        this.client.on('message', async (msg) => {
            try { await this._handleMessage(msg); }
            catch (e) { this.sendLog('[WhatsApp] ⚠️ خطأ: ' + e.message); }
        });

        this.client.on('disconnected', (reason) => {
            this.status = 'disconnected';
            this._updateStatus('disconnected');
            this.sendLog('[WhatsApp] ❌ واتساب انفصل: ' + reason);
        });

        this.client.on('auth_failure', (msg) => {
            this.status = 'auth_failed';
            this._updateStatus('auth_failed');
            this.sendLog('[WhatsApp] ❌ فشل المصادقة: ' + msg);
        });

        try {
            // Timeout wrapper: if initialize() hangs for 3 min, kill and retry
            await Promise.race([
                this.client.initialize(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Initialize timeout (3 min)')), 180000))
            ]);
            return { success: true, status: 'initializing' };
        } catch (err) {
            this.sendLog('[WhatsApp] ❌ فشل تهيئة واتساب: ' + err.message);
            // Destroy hung client
            try { if (this.client) await this.client.destroy(); } catch (e) {}
            this.client = null;
            // Clean stale Puppeteer lock files that prevent re-launch
            this._cleanStaleLocks();
            this._updateStatus('error');

            // Auto-retry up to 3 times
            if (!this._initRetries) this._initRetries = 0;
            this._initRetries++;
            if (this._initRetries <= 3) {
                this.sendLog('[WhatsApp] 🔄 إعادة المحاولة ' + this._initRetries + '/3 بعد 10 ثوانٍ...');
                await new Promise(r => setTimeout(r, 10000));
                return this.connect();
            }
            this._initRetries = 0;
            return { success: false, error: err.message };
        }
    }

    _cleanStaleLocks() {
        try {
            const sessionDir = path.join(WA_SESSIONS_DIR, 'session-haleem_server');
            const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
            for (const f of lockFiles) {
                const p = path.join(sessionDir, f);
                if (fs.existsSync(p)) { fs.removeSync(p); this.sendLog('[WhatsApp] 🧹 حذف lock: ' + f); }
                const dp = path.join(sessionDir, 'Default', f);
                if (fs.existsSync(dp)) { fs.removeSync(dp); this.sendLog('[WhatsApp] 🧹 حذف lock: Default/' + f); }
            }
        } catch (e) {
            this.sendLog('[WhatsApp] ⚠️ فشل تنظيف locks: ' + e.message);
        }
    }

    // ─── Disconnect ──────────────────────────────────────
    async disconnect() {
        if (!this.client) return;
        try { await this.client.destroy(); } catch (e) {}
        this.client = null;
        this.status = 'disconnected';
        this._updateStatus('disconnected');
        this.sendLog('[WhatsApp] 🔌 تم فصل واتساب.');
    }

    _updateStatus(st) {
        this.status = st;
        this.sendStatus(st);
    }

    // ─── Reply to old unread DMs ─────────────────────────
    async _replyToOldUnread() {
        try {
            this.sendLog('[WhatsApp] 🔍 جاري فحص الرسائل غير المردود عليها...');
            const chats = await this.client.getChats();
            const dmChats = chats.filter(c => !c.isGroup && c.unreadCount > 0 && c.id._serialized !== 'status@broadcast');

            if (dmChats.length === 0) {
                this.sendLog('[WhatsApp] ✅ لا توجد رسائل تحتاج رداً.');
                return;
            }

            this.sendLog('[WhatsApp] 📨 ' + dmChats.length + ' محادثة غير مردود عليها.');

            for (const chat of dmChats) {
                try {
                    const msgs = await chat.fetchMessages({ limit: 5 });
                    const lastMsg = msgs.reverse().find(m => !m.fromMe && m.body && m.body.trim().length > 0 && m.from !== 'status@broadcast');
                    if (!lastMsg) continue;
                    if (this._repliedMsgIds.has(lastMsg.id._serialized)) continue;
                    this._repliedMsgIds.add(lastMsg.id._serialized);
                    await this._handleDM(lastMsg);
                    await new Promise(r => setTimeout(r, 2000));
                } catch (e) {
                    this.sendLog('[WhatsApp] ⚠️ فشل الرد على محادثة: ' + e.message);
                }
            }
        } catch (e) {
            this.sendLog('[WhatsApp] ⚠️ فشل فحص الرسائل: ' + e.message);
        }
    }

    // ─── Message Router ────────────────────────────────────────
    async _handleMessage(msg) {
        // Dedup check FIRST — before any async work
        const msgId = msg.id._serialized || msg.id.id;
        if (this._repliedMsgIds.has(msgId)) return;
        this._repliedMsgIds.add(msgId);

        // Cap set size to prevent memory leak
        if (this._repliedMsgIds.size > 5000) {
            const arr = Array.from(this._repliedMsgIds);
            this._repliedMsgIds = new Set(arr.slice(arr.length - 2000));
        }

        if (msg.from === 'status@broadcast') return;
        if (msg.fromMe) return;

        const chat = await msg.getChat();
        if (chat.isGroup) return;

        // Per-chat lock: only one reply at a time per conversation
        const chatId = msg.from;
        if (this._chatLocks.has(chatId)) return;
        this._chatLocks.add(chatId);
        try {
            await this._handleDM(msg);
        } finally {
            this._chatLocks.delete(chatId);
        }
    }

    // ─── Purchase Flow ───────────────────────────────────
    _getChatState(chatId) {
        return this._chatStates.get(chatId) || null;
    }

    async _handlePurchaseFlow(msg, chatId) {
        const st = this._chatStates.get(chatId);
        if (!st) return false;
        const text = (msg.body || '').trim();

        if (st.state === 'waiting_name') {
            if (!isValidName(text)) {
                await msg.reply('من فضلك أرسل اسمك الحقيقي بشكل صحيح لتسجيله على مفتاح التفعيل (مثال: محمد أحمد).');
                return true;
            }
            st.name = text;
            st.state = 'waiting_phone';
            this._chatStates.set(chatId, st);
            await msg.reply('تمام يا ' + text + ' 👋\nكمان حاجة — أرسل لي رقم هاتفك بشكل صحيح عشان نربطه بالمفتاح.');
            this.sendLog('[WhatsApp] 🛒 شراء — استلم اسم: ' + text);
            return true;
        }

        if (st.state === 'waiting_phone') {
            if (!isValidPhone(text)) {
                await msg.reply('من فضلك أرسل رقم هاتف صحيح لنتمكن من ربطه بمفتاح التفعيل (مثال: 01223877211).');
                return true;
            }
            st.phone = text;
            this.sendLog('[WhatsApp] 🛒 شراء — استلم رقم: ' + text + ' — جاري إنشاء المفتاح...');
            await msg.reply('⏳ جاري إنشاء مفتاح التفعيل...');

            try {
                const key = await this._createKey(st.name, st.phone);
                const tunnelUrl = this._getTunnelUrlFn ? this._getTunnelUrlFn() : '';

                let response = '✅ تم إنشاء مفتاح التفعيل بنجاح!\n\n';
                response += '🔑 المفتاح: ' + key + '\n';
                if (tunnelUrl) response += '🌍 لينك السيرفر: ' + tunnelUrl + '\n';
                response += '\n📋 خطوات التفعيل:\n';
                response += '1. افتح بريمير وافتح البلجن\n';
                response += '2. ضع المفتاح في خانة License Key\n';
                response += '3. ستظهر خانة جديدة — ضع فيها لينك السيرفر\n';
                response += '4. اضغط Activate\n\n';
                response += '💰 طريقة الدفع:\n';
                response += '• فودافون كاش: 01223877211\n';
                response += '• باي بال: lemo122820@gmail.com\n\n';
                response += '💵 السعر: 200 جنيه مصري أو 5 دولار\n\n';
                response += 'بعد الدفع أرسل لنا صورة الإيصال وسنفعّل المفتاح فوراً ✨';

                await msg.reply(response);
                this.sendLog('[WhatsApp] ✅ تم إرسال المفتاح ' + key + ' للعميل ' + st.name);

                st.state = 'waiting_receipt';
                st.key = key;
                this._chatStates.set(chatId, st);
            } catch (e) {
                this._chatStates.delete(chatId);
                await msg.reply('⚠️ حصل خطأ في إنشاء المفتاح. جرب تاني أو تواصل معانا مباشرة.');
                this.sendLog('[WhatsApp] ❌ فشل إنشاء مفتاح: ' + e.message);
            }
            return true;
        }

        if (st.state === 'waiting_receipt') {
            if (msg.hasMedia) {
                try {
                    const media = await msg.downloadMedia();
                    const ownerNumber = '201223877211@c.us';
                    const chat = await this.client.getChatById(ownerNumber);

                    let ownerMsg = '🧾 *إيصال دفع جديد*\n\n';
                    ownerMsg += '👤 الاسم: ' + st.name + '\n';
                    ownerMsg += '📞 الرقم: ' + st.phone + '\n';
                    ownerMsg += '🔑 المفتاح: ' + st.key + '\n\n';
                    ownerMsg += '⚡ يرجى التأكد من وصول الدفع وتنشيط المفتاح.';

                    await chat.sendMessage(ownerMsg);
                    if (media) await chat.sendMessage(media);

                    this._chatStates.delete(chatId);
                    await msg.reply('✅ تم استلام إيصال الدفع!\n\nجاري مراجعته وتفعيل المفتاح. سيتم إخطارك فور التنشيط ✨\nشكراً لثقتك بنا! 🙏');
                    this.sendLog('[WhatsApp] 🧾 إيصال دفع من ' + st.name + ' — تم إرساله للمالك');
                } catch (e) {
                    await msg.reply('⚠️ حصل خطأ في إرسال الإيصال. أرسل الصورة مرة تانية.');
                    this.sendLog('[WhatsApp] ⚠️ فشل إرسال إيصال: ' + e.message);
                }
                return true;
            } else {
                await msg.reply('📸 من فضلك أرسل *صورة* إيصال الدفع عشان نقدر نفعّل المفتاح.');
                return true;
            }
        }

        return false;
    }

    async _createKey(name, phone) {
        if (this._createKeyFn) {
            return await this._createKeyFn(name, phone);
        }
        throw new Error('createKey function not set');
    }

    // ─── Install Guide (Text only, no video) ────────────────────
    async _sendInstallGuide(msg) {
        try {
            const chat = await msg.getChat();
            await chat.sendMessage(INSTALL_GUIDE_TEXT);
            this.sendLog('[WhatsApp] 📋 تم إرسال دليل التثبيت');
        } catch (e) {
            this.sendLog('[WhatsApp] ⚠️ فشل إرسال دليل التثبيت: ' + e.message);
        }
    }

    _isDownloadRequest(text) {
        const lower = text.toLowerCase();
        return DOWNLOAD_KEYWORDS.some(kw => lower.includes(kw));
    }

    // ─── DM Handler (Ollama + Knowledge Base) ────────────
    async _handleDM(msg) {
        try {
            const contact = await msg.getContact();
            const contactName = contact.pushname || contact.name || 'مجهول';

            // Voice → ask to type
            if (msg.type === 'ptt' || msg.type === 'audio') {
                await msg.reply('مرحباً! للأسف لا أستطيع سماع الرسائل الصوتية حالياً 🎤\nممكن تكتب لي رسالتك؟ 😊');
                this.sendLog('[WhatsApp] 🎤 صوتية من ' + contactName + ' — طلب الكتابة');
                return;
            }

            // Determine content
            let messageContent = msg.body || '';
            if (!messageContent.trim()) {
                if (msg.type === 'sticker') messageContent = '[ستيكر]';
                else if (msg.type === 'image') messageContent = '[صورة]';
                else if (msg.type === 'video') messageContent = '[فيديو]';
                else messageContent = '[رسالة]';
            }

            this.sendLog('[WhatsApp] 💬 رسالة من ' + contactName + ': "' + messageContent.substring(0, 50) + '..."');

            // Check purchase flow first
            const chatId = msg.from;
            if (this._getChatState(chatId)) {
                const handled = await this._handlePurchaseFlow(msg, chatId);
                if (handled) return;
            }

            // Detect download/install request → send guide, NOT purchase
            if (messageContent.trim() && this._isDownloadRequest(messageContent)) {
                this.sendLog('[WhatsApp] 📥 طلب تحميل من ' + contactName + ' — إرسال دليل التثبيت');
                await this._sendInstallGuide(msg);
                this._sentInstallGuide.add(chatId);
                return;
            }

            // First contact — send install guide + video before replying
            if (!this._sentInstallGuide.has(chatId)) {
                await this._sendInstallGuide(msg);
                this._sentInstallGuide.add(chatId);
            }

            // Build KB context
            this._loadKB();
            let kbContext = '';
            const kb = this._knowledgeBase;
            if (Array.isArray(kb) && kb.length > 0) {
                const items = kb.map(function(item, i) {
                    let line = (i + 1) + '. ' + (item.title || 'بدون عنوان');
                    if (item.price) line += ' — السعر: ' + item.price;
                    if (item.description) line += '\n   ' + item.description;
                    if (item.qa) line += '\n   ' + item.qa;
                    const hasImg = item.images && item.images.length > 0;
                    if (hasImg) line += '\n   [صور متوفرة: ' + item.images.length + ' صورة]';
                    return line;
                }).join('\n');
                kbContext = '\n\nلديك المنتجات/المعلومات التالية:\n' + items + '\n\nمعلومات أساسية عن البلجن:\n- البلجن فيها فترة تجريبية مجانية (Free Trial) مدتها ساعتين تعمل فوراً بعد التثبيت بدون أي دفع.\n- بعد انتهاء الساعتين يحتاج العميل شراء مفتاح تفعيل.\n- السعر: 200 جنيه مصري أو 5 دولار.\n- إذا سأل العميل عن تجربة مجانية أو free trial أخبره أن البلجن تعمل ساعتين مجاناً بعد التثبيت مباشرة.\n\nتعليمات مهمة:\n- استخدم هذه المعلومات للإجابة على أسئلة العملاء بدقة.\n- إذا سأل العميل عن منتج موجود في القائمة، أجب من القائمة.\n- إذا طلب العميل صوراً لمنتج معين، وكان لهذا المنتج [صور متوفرة]، أضف في نهاية ردك بالضبط: [IMG:رقم المنتج] (مثلاً [IMG:1]).\n- لا تقل أبداً "الصور غير متوفرة" إذا كان المنتج يحمل علامة [صور متوفرة].\n- أرسل صور المنتج الصحيح فقط.\n- قل [BUY] فقط وحصراً إذا قال العميل كلمة "شراء" أو "اشتري" أو "الدفع" أو "أريد أدفع" أو "عايز أشتري" أو "أبي أطلب" أو "ابي اخذ المنتج".\n- لا تقل [BUY] أبداً إذا قال العميل "تحميل" أو "تنزيل" أو "أريد تحميل" أو "download" أو "install" — هذا ليس شراء بل طلب تثبيت مجاني.\n- كلمة "تحميل" و"تنزيل" تعني فقط أنه يريد التثبيت المجاني (الفترة التجريبية ساعتين).\n- لا تقل [BUY] أبداً للتحيات (هاي، مرحبا، سلام، هلا، hello) أو الأسئلة العامة أو الاستفسارات أو الإيموجي أو الستيكر أو أي رسالة ليست طلب شراء صريح.\n- لا تطلب اسم أو رقم هاتف العميل إلا إذا طلب الشراء صراحةً.\n- إذا شككت هل العميل يريد الشراء أم لا، لا تقل [BUY] — بل أجب بشكل طبيعي واسأله إذا يحتاج مساعدة.';
            }

            const prompt = 'رسالة من "' + contactName + '": "' + messageContent + '"';
            const systemPrompt = this._systemPrompt + kbContext;
            let reply = await this.ollama.generate(prompt, systemPrompt, this._ollamaModel);

            // Check if Ollama detected purchase intent
            if (reply && reply.trim().includes('[BUY]')) {
                this._chatStates.set(chatId, { state: 'waiting_name', name: '', phone: '' });
                await msg.reply('أهلاً بيك! 🎉 عشان نجهز لك مفتاح التفعيل، ممكن تقول لي اسمك الكامل؟');
                this.sendLog('[WhatsApp] 🛒 طلب شراء من ' + contactName + ' — بانتظار الاسم');
                return;
            }

            if (reply && reply.trim()) {
                // Parse [IMG:N]
                const imgTagRegex = /\[IMG:(\d+)\]/gi;
                const imgMatches = [...reply.matchAll(imgTagRegex)];
                const cleanReply = reply.replace(imgTagRegex, '').trim();

                await msg.reply(cleanReply);
                this.sendLog('[WhatsApp] ✅ رد على ' + contactName + ': "' + cleanReply.substring(0, 50) + '..."');

                // Send images
                if (imgMatches.length > 0 && Array.isArray(kb)) {
                    const chat = await msg.getChat();
                    const sentProducts = new Set();
                    for (const match of imgMatches) {
                        const productIdx = parseInt(match[1], 10) - 1;
                        if (productIdx < 0 || productIdx >= kb.length) continue;
                        if (sentProducts.has(productIdx)) continue;
                        sentProducts.add(productIdx);

                        const item = kb[productIdx];
                        if (!item.images || item.images.length === 0) continue;

                        for (const imgPath of item.images) {
                            try {
                                if (fs.existsSync(imgPath)) {
                                    const media = MessageMedia.fromFilePath(imgPath);
                                    await chat.sendMessage(media);
                                    this.sendLog('[WhatsApp] 🖼️ إرسال صورة: ' + item.title);
                                    await new Promise(r => setTimeout(r, 1000));
                                }
                            } catch (imgErr) {
                                this.sendLog('[WhatsApp] ⚠️ فشل إرسال صورة: ' + imgErr.message);
                            }
                        }
                    }
                }
            }
        } catch (e) {
            this.sendLog('[WhatsApp] ⚠️ فشل الرد التلقائي: ' + e.message);
            // Fallback reply when Ollama is down so the customer isn't ignored
            try {
                await msg.reply('أهلاً! شكراً لرسالتك 😊 سيتم الرد عليك قريباً.');
            } catch (replyErr) {
                this.sendLog('[WhatsApp] ⚠️ فشل إرسال رد احتياطي: ' + replyErr.message);
            }
        }
    }
}

module.exports = WhatsAppBot;
