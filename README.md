# Cloudyte

**Cloudyte** is an easy-to-use tool that lets you manage your Google Drive, OneDrive, and Telegram files all in one place. Whether you're using our clean web dashboard or our friendly Telegram bot, you'll always have your important files at your fingertips.

---

## ✨ Key Features

### 📂 Your Files, Everywhere
- **Google Drive & OneDrive**: Connect your accounts and browse your files just like a regular folder.
- **Telegram Storage**: Use your private Telegram channels as a free, unlimited cloud backup.
- **Large Files**: Don't worry about size—Cloudyte handles big uploads smoothly.

### 🤖 The Telegram Bot
- **Browse on the Go**: Scroll through your cloud folders directly inside Telegram.
- **Easy Search**: Find any file by name across all your accounts with one command.
- **Quick Backup**: Just send a file or photo to the bot to save it to your cloud instantly.
- **Fast Setup**: Add or remove storage accounts anytime using simple chat buttons.

### 🌐 Clean Web Dashboard
- **Modern Design**: A beautiful, simple-to-use website for managing your files.
- **Upload Tracker**: See exactly how much time is left on your uploads with progress bars.
- **Admin Tools**: Special features for account owners to see how much storage is being used.
- **Easy Sharing**: Create one-click links to share files with friends safely.

---

## 🛠️ How It's Made

- **Built with**: React (for the website) and Node.js (for the engine).
- **Storage**: Uses MongoDB to keep your file list organized and fast.
- **Connections**: Securely connects to Google and Microsoft using standard login methods.

---

## ⚙️ Deployment & Setup Guide

Following these steps will get your Cloudyte instance running in a production environment.

### 1. API Provider Configuration

#### 🌐 Google Drive (Google Cloud Console)
1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project and enable the **Google Drive API**.
3. Configure the **OAuth Consent Screen** (Internal or External).
4. Create **OAuth 2.0 Client IDs** (Web Application).
5. Add `https://your-domain.com/api/auth/google/callback` to the **Authorized Redirect URIs**.

#### ☁️ Microsoft OneDrive (Azure Portal)
1. Go to the [Azure Portal - App Registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade).
2. Register a new application.
3. Under **Authentication**, add a platform (Web) and set the redirect URI to `https://your-domain.com/api/auth/onedrive/callback`.
4. Create a **Client Secret** under "Certificates & secrets".
5. Add the following permissions: `Files.ReadWrite.All`, `offline_access`, `User.Read`.

#### 🤖 Telegram Bot (BotFather)
1. Message [@BotFather](https://t.me/botfather) to create a new bot.
2. Save the **API Token**.
3. (Optional) Get your `API_ID` and `API_HASH` from [my.telegram.org](https://my.telegram.org/auth) if you plan to use advanced Telegram storage features.

---

### 2. Database Setup
Cloudyte uses **MongoDB** to store user information and file metadata.
1. Create a free cluster on [MongoDB Atlas](https://www.mongodb.com/cloud/atlas).
2. Under "Network Access", allow your server's IP address.
3. Copy your **Connection String** (e.g., `mongodb+srv://...`).

---

### 3. Environment Variables
Create a `.env` file and fill in your secrets. **Never share this file.**

| Variable | Description |
| :--- | :--- |
| `MONGODB_URI` | Your MongoDB connection string. |
| `TELEGRAM_BOT_TOKEN` | Token from BotFather. |
| `APP_URL` | The public URL where your app is hosted. |
| `GOOGLE_CLIENT_ID` | From Google Cloud Console. |
| `GOOGLE_CLIENT_SECRET` | From Google Cloud Console. |
| `MICROSOFT_CLIENT_ID` | From Azure Portal. |
| `MICROSOFT_CLIENT_SECRET` | From Azure Portal. |
| `ADMIN_USERNAME` | Default admin username for the web dashboard. |
| `ADMIN_PASSWORD` | Default admin password. |

---

### 4. Running in Production
We recommend using **PM2** to manage your Node.js process so it stays online.

```bash
# Install PM2 globally
npm install -g pm2

# Build the project
npm run build

# Start with PM2
pm2 start dist/server.cjs --name cloudyte

# Save and setup boot restart
pm2 save
pm2 startup
```

---

❤️ Built for Speed & Privacy
Created by Arshman