# HALEEM Activation Server — Linux Edition

سيرفر تفعيل HALEEM-ULTRA للتشغيل كـ daemon على Ubuntu/Debian. يشمل: سيرفر التراخيص، بوت واتساب (Gemma AI)، ونفق Ngrok للوصول العالمي.

---

## ⚡ التثبيت السريع

```bash
rm -rf /tmp/LINUX-SERVER && git clone https://github.com/haleemrz/LINUX-SERVER.git /tmp/LINUX-SERVER && cd /tmp/LINUX-SERVER && chmod +x install.sh && sudo ./install.sh && rm -rf /tmp/LINUX-SERVER
```

---

## 🏗️ بنية السيرفر

### المنافذ (Ports)

| المنفذ | البروتوكول | الوظيفة |
|--------|-----------|---------|
| `9847` | HTTPS | سيرفر التراخيص (مع SSL) |
| `9848` | HTTP | سيرفر التراخيص (بدون SSL) — يستخدمه Ngrok |
| `11434` | HTTP | Ollama AI (محلي فقط) |

### نفق Ngrok

- يُنشأ تلقائياً على المنفذ `9848` (HTTP)
- يوفر رابط HTTPS عالمي: `https://xxx.ngrok-free.dev`
- حساب Ngrok المجاني يسمح بـ **tunnel واحد فقط** — أغلق أي tunnel آخر (مثل تطبيق سطح المكتب) قبل التشغيل

---

## 📡 API Endpoints

### عامة (بدون مصادقة)

| Method | Path | الوظيفة |
|--------|------|---------|
| `GET` | `/ping` | فحص اتصال السيرفر |
| `GET` | `/wa-qr` | صفحة ويب لعرض QR Code واتساب (افتحها في المتصفح لمسح الكود) |

### تفعيل البلجن (Plugin Client)

| Method | Path | الوظيفة |
|--------|------|---------|
| `POST` | `/activate` | تفعيل مفتاح (v3 — HMAC بالمفتاح) |
| `POST` | `/api/activate` | تفعيل مفتاح (v2 — APP_TOKEN signing) |
| `POST` | `/api/check` | فحص حالة الترخيص (v2) |

> **ملاحظة:** التفعيل **تلقائي** — المفتاح ينتقل من `unused` مباشرة إلى `activated` بدون خطوة "pending".

### إدارة المفاتيح (Admin — يتطلب Bearer Token)

| Method | Path | الوظيفة |
|--------|------|---------|
| `GET` | `/status` | حالة السيرفر والإحصائيات |
| `GET` | `/clients` | قائمة جميع التراخيص |
| `GET` | `/requests` | طلبات التفعيل المعلقة |
| `POST` | `/create-key` | إنشاء مفتاح جديد |
| `POST` | `/delete-key` | حذف مفتاح |
| `POST` | `/activate` | تفعيل مفتاح (admin) |
| `POST` | `/revoke` | إلغاء تفعيل مفتاح |
| `POST` | `/reactivate` | إعادة تفعيل مفتاح ملغي |
| `POST` | `/pair-device` | ربط جهاز إدارة |
| `POST` | `/unpair-device` | فك ربط جهاز |

### واتساب Bot API (Admin)

| Method | Path | الوظيفة |
|--------|------|---------|
| `GET` | `/wa-status` | حالة الواتساب + QR + اللوج |
| `POST` | `/wa-start` | بدء اتصال واتساب |
| `POST` | `/wa-stop` | إيقاف واتساب |
| `GET` | `/wa-get-kb` | جلب قاعدة المعرفة |
| `POST` | `/wa-save-kb` | حفظ قاعدة المعرفة |

---

## 📂 ملفات البيانات

جميع البيانات في: `~/.haleem-server/`

```
~/.haleem-server/
├── config.json              # Admin Token + Storage Key
├── wa_knowledge_base.json   # قاعدة معرفة بوت واتساب
├── data/
│   └── licenses.enc         # قاعدة بيانات التراخيص (مشفرة AES-256-GCM)
├── rsa/
│   ├── private.pem          # مفتاح RSA الخاص (لتوقيع التراخيص)
│   └── public.pem           # مفتاح RSA العام
├── ssl/
│   ├── cert.pem             # شهادة SSL ذاتية التوقيع
│   └── key.pem              # مفتاح SSL
└── wa_sessions/             # جلسات واتساب (Puppeteer/Chrome)
```

### مزامنة البيانات من ويندوز إلى لينكس

لو كنت تستخدم تطبيق سطح المكتب على ويندوز وتريد نقل البيانات للينكس:

```powershell
# من PowerShell على ويندوز:
scp "$env:USERPROFILE\.haleem-server\config.json" haleem@LINUX-IP:~/.haleem-server/config.json
scp "$env:USERPROFILE\.haleem-server\rsa\private.pem" haleem@LINUX-IP:~/.haleem-server/rsa/private.pem
scp "$env:USERPROFILE\.haleem-server\rsa\public.pem" haleem@LINUX-IP:~/.haleem-server/rsa/public.pem
scp "$env:USERPROFILE\.haleem-server\wa_knowledge_base.json" haleem@LINUX-IP:~/.haleem-server/wa_knowledge_base.json
# ثم أعد تشغيل السيرفر:
ssh haleem@LINUX-IP "sudo systemctl restart haleem-server"
```

---

## ⚙️ إدارة الخدمة

```bash
# حالة السيرفر
sudo systemctl status haleem-server

# إيقاف
sudo systemctl stop haleem-server

# تشغيل
sudo systemctl start haleem-server

# إعادة تشغيل
sudo systemctl restart haleem-server

# اللوج المباشر
sudo journalctl -u haleem-server -f --no-pager

# فحص Ngrok
sudo journalctl -u haleem-server --no-pager | grep TUNNEL_CONNECTED | tail -1

# فحص واتساب
sudo journalctl -u haleem-server --no-pager | grep WA_STATUS | tail -5
```

---

## 📱 مسح QR Code واتساب

بعد التثبيت، افتح في المتصفح:

```
http://LINUX-IP:9848/wa-qr
```

ستظهر صفحة ويب فيها QR Code — امسحه من واتساب على هاتفك (الإعدادات ← الأجهزة المرتبطة ← ربط جهاز). الصفحة تتحدث تلقائياً كل 15 ثانية.

---

## 🔐 الأمان

- **Admin API**: يتطلب `Authorization: Bearer TOKEN` + HMAC signature + timestamp + nonce
- **Client API (v3)**: HMAC-SHA256 بالمفتاح كـ secret
- **Client API (v2)**: APP_TOKEN HMAC signing
- **Rate Limiting**: 30 طلب/دقيقة لكل IP
- **التراخيص**: مشفرة AES-256-GCM على القرص
- **Device Binding**: كل مفتاح مربوط بجهاز واحد (device fingerprint)

---

## 🤖 بوت واتساب (Gemma AI)

- يستخدم نموذج **Gemma 4 27B** عبر Ollama
- يرد تلقائياً على استفسارات العملاء بناءً على قاعدة المعرفة
- يُنشئ مفاتيح تفعيل تلقائياً عند طلب الشراء
- يرسل رابط Ngrok مع المفتاح للعميل

---

## 📋 المتطلبات

- Ubuntu 22.04+ / Debian 12+
- Node.js 18+
- Ngrok (مثبّت ومُعَد بـ authtoken)
- Ollama (لبوت واتساب)
- Chromium dependencies (يثبّتها install.sh تلقائياً)
