# 🚀 Solana Copytrading Bot

This project is a **copytrading bot** on the **Solana blockchain** that monitors and automatically replicates trades using **PumpPortal**, **Raydium**, and **PumpSwap**. The bot sends real-time trade notifications via **Telegram**.

## ⚡ Key Features

- **Multi-Platform Copytrading**: Supports all major Solana trading services – PumpPortal, Raydium, and PumpSwap.
- **Ultra-Fast Execution**: Front-runs within 1–2 blocks using Jito block engine.
- **Wallet Monitoring**: Automatically copies trades from selected wallets.
- **Telegram Notifications**: Instant alerts with full transaction details.
- **Customizable Config**: Adjust settings via `.env`.

> 💡 Unlike most bots tied to a single platform, this bot supports **multi-source copytrading** with minimal delay.

---

## 📦 What's Included

This repo includes:
- Project structure and setup guide  
- `.env.example` file  
- Full documentation  
- Integration instructions

> 🔐 The core trading logic (`src/config.ts`) is **excluded** from the public version to prevent unauthorized use.

---

## 💰 Purchase & Access

To get full access, including the `config.ts` logic and lifetime updates:

### 💸 One-time payment — **4SOL**

✅ Lifetime access  
✅ All future updates  
✅ Telegram support  
✅ No subscriptions  

📩 To buy, contact: [@iluasarg on Telegram](https://t.me/iluasarg)

---

## 🛠 Requirements

- Node.js and npm installed
- A funded Solana wallet
- PumpPortal, Raydium, and Telegram credentials
- Basic knowledge of `.env` configuration

---

## 🔑 PumpPortal Setup (API, Wallet, Keys)

To use the PumpPortal API:

1. Go to [https://pumpportal.fun](https://pumpportal.fun)
2. Generate a new wallet and API key.
3. Save your:
   - **Public Key** (wallet address)
   - **Private Key** (secret key)
   - **API Key** (for trading access)
4. Add them to your `.env`:
   ```bash
   PUMPPORTAL_PUBLIC_KEY=your_public_key
   PUMPPORTAL_PRIVATE_KEY=your_private_key
   PUMPPORTAL_API_KEY=your_api_key
   ```

> ⚠️ Keys are shown only once – don’t forget to save them.

---

## 🧪 Installation

```bash
git clone https://github.com/Iluasarg/solana-copytrading-bot.git
cd solana-copytrading-bot

npm install
```

Then create a `.env` file based on `.env.example` and fill in your details.

---

## 🚀 Usage

1. After purchasing, you will receive the `config.ts` file.
2. Place it into the `src` folder.
3. Start the bot:

```bash
npm start
```

You’ll start seeing Telegram alerts for copied trades.

---

## 🧠 Notes

- Make sure your wallet has enough SOL for fees.
- Works with both private and public wallets.
- Ideal for PnL-copying strategies, passive investing, or real-time trade mirroring.

---

## 🧑‍💻 Support

Need help or want to talk before buying? Message me anytime:  
📩 [@iluasarg](https://t.me/iluasarg)

