

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const { Telegraf, Markup } = require('telegraf');
const crypto = require('crypto');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '100kb' }));
app.use(express.static(__dirname));

// ================= SECURITY HELPERS ================= //
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'super_secret_dash_admin_2026';
const KENO_SHARED_SECRET = process.env.KENO_SHARED_SECRET || 'FAST_KENO_DASH_SECRET_KEY_2026';
// Set REQUIRE_TG_AUTH=true once your Bingo frontend sends `x-telegram-init-data` header
const REQUIRE_TG_AUTH = process.env.REQUIRE_TG_AUTH === 'true';

function safeCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function verifyTelegramInitData(initData) {
    if (!initData || !process.env.BOT_TOKEN) return null;
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash') || '';
        const authDate = parseInt(urlParams.get('auth_date') || '0', 10);
        urlParams.delete('hash');
        const nowSec = Math.floor(Date.now() / 1000);
        if (!authDate || Math.abs(nowSec - authDate) > 86400 * 7) return null;

        const params = Array.from(urlParams.entries()).map(([k, v]) => `${k}=${v}`).sort().join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(params).digest('hex');
        if (!safeCompare(calculatedHash, hash)) return null;

        const userData = JSON.parse(urlParams.get('user') || '{}');
        if (!userData.id) return null;
        return Number(userData.id);
    } catch {
        return null;
    }
}

function resolveTelegramUser(req, res, next) {
    const initData = req.headers['x-telegram-init-data'];
    if (initData) {
        const verifiedId = verifyTelegramInitData(initData);
        if (!verifiedId) {
            return res.status(401).json({ error: 'Invalid Telegram signature' });
        }
        req.verifiedTelegramId = verifiedId;
        return next();
    }
    if (REQUIRE_TG_AUTH) {
        return res.status(401).json({ error: 'Telegram authentication required' });
    }
    next();
}

// ================= DATABASE CONNECTION (NEON POSTGRES) ================= //
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 30,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

pool.on('error', (err) => console.error('Neon DB Pool Error:', err.message));

(async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                telegram_id BIGINT UNIQUE NOT NULL,
                first_name VARCHAR(100),
                username VARCHAR(100),
                real_balance NUMERIC(12, 2) DEFAULT 0.00 CHECK (real_balance >= 0),
                bonus_balance NUMERIC(12, 2) DEFAULT 0.00 CHECK (bonus_balance >= 0),
                balance NUMERIC(12, 2) DEFAULT 0.00,
                total_deposited NUMERIC(12, 2) DEFAULT 0.00 CHECK (total_deposited >= 0),
                total_withdrawn NUMERIC(12, 2) DEFAULT 0.00,
                total_won NUMERIC(12, 2) DEFAULT 0.00,
                cards_bought_this_week INT DEFAULT 0,
                referred_by BIGINT,
                referral_rewarded BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                type VARCHAR(20) NOT NULL,
                payment_method VARCHAR(20) NOT NULL,
                amount NUMERIC(12, 2) NOT NULL,
                gross_amount NUMERIC(12, 2) DEFAULT NULL,
                fee_amount NUMERIC(12, 2) DEFAULT 0.00,
                sms_text TEXT,
                sms_hash VARCHAR(64) UNIQUE,
                trx_ref VARCHAR(64) UNIQUE,
                order_id VARCHAR(64) UNIQUE,
                external_ref VARCHAR(128) UNIQUE,
                account_number VARCHAR(100),
                account_name VARCHAR(100),
                status VARCHAR(20) DEFAULT 'PENDING',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS bingo_rounds (
                id SERIAL PRIMARY KEY,
                round_number BIGINT NOT NULL,
                card_price NUMERIC(10, 2) DEFAULT 10.00,
                total_cards INT DEFAULT 0,
                pool_prize NUMERIC(12, 2) DEFAULT 0.00,
                owner_rake NUMERIC(12, 2) DEFAULT 0.00,
                winner_id INT REFERENCES users(id),
                winning_card_number INT,
                status VARCHAR(20) DEFAULT 'COMPLETED',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS promo_codes (
                id SERIAL PRIMARY KEY,
                code VARCHAR(50) UNIQUE NOT NULL,
                reward_amount NUMERIC(10, 2) NOT NULL CHECK (reward_amount > 0),
                max_uses INT NOT NULL DEFAULT 10,
                times_used INT NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS promo_claims (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                promo_id INT REFERENCES promo_codes(id) ON DELETE CASCADE,
                claimed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, promo_id)
            );

            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS gross_amount NUMERIC(12, 2) DEFAULT NULL;
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS fee_amount NUMERIC(12, 2) DEFAULT 0.00;
            ALTER TABLE transactions ADD COLUMN IF NOT EXISTS external_ref VARCHAR(128);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_external_ref ON transactions (external_ref) WHERE external_ref IS NOT NULL;
        `);
        console.log('✅ Dash Bingo Database Schema verified safely.');
    } catch (e) {
        console.error('Migration notice:', e.message);
    }
})();

// ================= STATIC ROUTES ================= //
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

function checkAdminAuth(req, res, next) {
    const key = String(req.headers['x-admin-key'] || req.query.admin_key || '');
    if (!key || !safeCompare(key, ADMIN_SECRET)) {
        return res.status(403).json({ error: 'ያልተፈቀደ መዳረሻ! የተሳሳተ የአድሚን ቁልፍ።' });
    }
    next();
}

// ================= TELEGRAM BOT & NOTIFICATIONS ================= //
const bot = new Telegraf(process.env.BOT_TOKEN);
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://dashbingo.onrender.com';
const CHANNEL_ID = '@DashBingo';

async function sendTelegramNotification(telegramId, message) {
    try {
        if (!telegramId) return;
        await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'HTML' });
    } catch (err) {
        console.warn(`Telegram notification notice (${telegramId}):`, err.message);
    }
}

// ================= VERIFI V5 CREDENTIALS & REGEX ================= //
const TELEBIRR_API_URL = process.env.TELEBIRR_API_URL || process.env.VERIFY_API_URL || 'https://verifiy-server.app.aletcloud.com/api/verify';
const TELEBIRR_SECRET_TOKEN = process.env.TELEBIRR_SECRET_TOKEN || process.env.VERIFY_SECRET_TOKEN || 'Verifi_Prod_9842_Aymen_X9!2026';
const MINIMUM_DEPOSIT = 50;

function parsePaymentInput(input, method = 'TELEBIRR') {
    const text = String(input || '').trim();
    let ref = null;
    let amount = null;

    if (String(method).toUpperCase() === 'CBE') {
        const cbeMatch = text.match(/\b(FT[A-Z0-9]{8,14})\b/i) || text.match(/(?:Txn\s*ID|Txn\s*Ref|Ref|ቁጥር|ትዕዛዝ)\s*[:፡-]?\s*([A-Z0-9]{8,16})/i);
        if (cbeMatch) ref = cbeMatch[1].toUpperCase();
        else if (/^[A-Z0-9]{8,18}$/i.test(text)) ref = text.toUpperCase();
    } else {
        const tbMatch = text.match(/\b(D[A-Z][A-Z0-9]{8,12})\b/i);
        if (tbMatch) ref = tbMatch[1].toUpperCase();
        else {
            const genericMatch = text.match(/transaction\s*(?:number|id|ref|no)?\s*(?:is|:)?\s*([A-Z0-9]{8,14})/i);
            if (genericMatch) ref = genericMatch[1].toUpperCase();
            else if (/^[A-Z0-9]{8,14}$/i.test(text)) ref = text.toUpperCase();
        }
    }

    const amtMatch = text.match(/(?:ETB|Birr|ብር)\s*([0-9,]+(?:\.[0-9]{1,2})?)/i) || text.match(/\b([0-9,]+(?:\.[0-9]{1,2})?)\s*(?:ETB|Birr|ብር)/i);
    if (amtMatch) amount = parseFloat(amtMatch[1].replace(/,/g, ''));

    return { ref, amount };
}

// ================= AGENT STATUS ================= //
let agentStatus = {
    telebirr: { name: "Aymen (Telebirr)", handle: "@Dashagent1", account: "0996910607", isOnline: true },
    cbe: { name: "Aymen (CBE Bank)", handle: "@Dashagent1", account: "1000562339427", isOnline: true }
};

app.get('/api/agents/status', (req, res) => res.json(agentStatus));

app.post('/api/admin/agents/toggle', checkAdminAuth, (req, res) => {
    const { isOnline } = req.body;
    agentStatus.telebirr.isOnline = Boolean(isOnline);
    if (agentStatus.cbe) agentStatus.cbe.isOnline = Boolean(isOnline);
    res.json({ success: true, agentStatus });
});

bot.start(async (ctx) => {
    const { id, first_name, username } = ctx.from;
    const startPayload = ctx.startPayload || '';

    let referrerId = null;
    if (startPayload.startsWith('ref_')) {
        const parsed = parseInt(startPayload.replace('ref_', ''), 10);
        if (!isNaN(parsed) && parsed !== id) referrerId = parsed;
    }

    try {
        await pool.query(
            `INSERT INTO users (telegram_id, first_name, username, referred_by) 
             VALUES ($1, $2, $3, $4) 
             ON CONFLICT (telegram_id) DO UPDATE 
             SET first_name = $2, username = $3`,
            [id, first_name || 'ተጫዋች', username || '', referrerId]
        );

        ctx.reply(
            `እንኳን ወደ <b>Dash Bingo ⚡</b> በደህና መጡ!\n\nበቴሌብር እና በንግድ ባንክ (CBE) ተቀማጭ በማድረግ አሁኑኑ መጫወት ይጀምሩ፦`,
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.webApp("🎮 Play Dash Bingo", WEBAPP_URL)]])
            }
        );
    } catch (err) {
        console.error("Bot start error:", err);
    }
});

// ================= GAME ENGINE (BINGO) ================= //
const CARD_PRICE = 10;
const HOUSE_COMMISSION = 0.20;
const SELECTION_SECONDS = 30;
const ENABLE_DEMO_BOTS = process.env.ENABLE_DEMO_BOTS !== 'false';
const TEST_LUCKY_MODE = process.env.TEST_LUCKY_MODE === 'true';
const LUCKY_WIN_CHANCE = 1;

const BOT_NAMES = [
    "የድል_ጎዳና ⚡", "💎 ብሩህ_አእምሮ ✨", "🦁 የአንበሳ_ፈለግ 🦅", "☕ የቡና_ሰዓት 🤎",
    "🌙 የሌሊት_ጥላ 🌌", "🎵 የዜማ_ሞገድ 🎧", "❄️ ቀዝቃዛ_አየር 🧊", "🌍 የሀገሬ_ልጅ 🇪🇹",
    "👑 የንግስና_ጊዜ 💫", "🌹 የፍቅር_ጉዞ 💕", "🍃 የተፈጥሮ_ድምጽ 🌿", "አቤል_ዘአበሻ",
    "ሰላም_ለእግዚአብሔር", "ዮሐንስ_አሸናፊ", "ዳዊት_ብርሃኑ", "ማርያም_ምስክሬ",
    "እድለኛው_ሰው", "ምስራቅ_ፀሐይ", "ፍቅሬ_ነህ", "ሐበሻዊው_ሰው",
    "የአባይ_ልጅ", "የወንዙ_ሞገድ", "የተስፋ_ብርሃን", "༺ 𝕷𝖊𝖌𝖊𝖓𝖉 ༻"
];

let gameState = {
    roundNumber: 1001,
    status: 'SELECTION',
    countdown: SELECTION_SECONDS,
    selectedCards: {},
    calledNumbers: [],
    currentNumber: null,
    totalPrize: 0,
    ownerProfit: 0
};

function generateBingoCard() {
    const getCols = (min, max) => {
        const nums = [];
        while (nums.length < 5) {
            const r = Math.floor(Math.random() * (max - min + 1)) + min;
            if (!nums.includes(r)) nums.push(r);
        }
        return nums;
    };
    const b = getCols(1, 15);
    const i = getCols(16, 30);
    const n = getCols(31, 45);
    const g = getCols(46, 60);
    const o = getCols(61, 75);
    n[2] = 0;
    return [b, i, n, g, o];
}

function checkWinner(card, called) {
    const isMarked = (val) => val === 0 || called.includes(val);
    for (let c = 0; c < 5; c++) if (card[c].every(isMarked)) return true;
    for (let r = 0; r < 5; r++) {
        let rowWin = true;
        for (let c = 0; c < 5; c++) if (!isMarked(card[c][r])) { rowWin = false; break; }
        if (rowWin) return true;
    }
    let diag1 = true, diag2 = true;
    for (let idx = 0; idx < 5; idx++) {
        if (!isMarked(card[idx][idx])) diag1 = false;
        if (!isMarked(card[idx][4 - idx])) diag2 = false;
    }
    return diag1 || diag2;
}

function simulateMassivePurchases(count = 12) {
    if (gameState.status !== 'SELECTION' || !ENABLE_DEMO_BOTS) return;

    const takenNow = [];
    for (let i = 0; i < count; i++) {
        let randomCard;
        let attempts = 0;
        do {
            randomCard = Math.floor(Math.random() * 500) + 1;
            attempts++;
        } while (gameState.selectedCards[randomCard] && attempts < 200);

        if (gameState.selectedCards[randomCard]) continue;
        const botName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
        gameState.selectedCards[randomCard] = {
            userId: null,
            userName: botName,
            numbers: generateBingoCard(),
            isBot: true
        };
        takenNow.push({ cardIndex: randomCard, userName: botName });
    }

    const cardCount = Object.keys(gameState.selectedCards).length;
    const totalPot = cardCount * CARD_PRICE;
    gameState.totalPrize = totalPot * (1 - HOUSE_COMMISSION);
    gameState.ownerProfit = totalPot * HOUSE_COMMISSION;

    for (const item of takenNow) {
        io.emit('card_taken', {
            cardIndex: item.cardIndex,
            userName: item.userName,
            totalCards: cardCount,
            poolPrize: gameState.totalPrize
        });
    }
}

function resetGame() {
    gameState.roundNumber++;
    gameState.status = 'SELECTION';
    gameState.countdown = SELECTION_SECONDS;
    gameState.selectedCards = {};
    gameState.calledNumbers = [];
    gameState.currentNumber = null;
    gameState.totalPrize = 0;
    gameState.ownerProfit = 0;
    io.emit('game_reset', gameState);
}

// Guarded non-overlapping Bingo loop
async function runBingoLoop() {
    try {
        if (gameState.status === 'SELECTION') {
            gameState.countdown--;
            io.emit('game_tick', { status: 'SELECTION', countdown: gameState.countdown });

            if (gameState.countdown > 1) {
                simulateMassivePurchases(Math.floor(Math.random() * 5) + 10);
            }

            if (gameState.countdown <= 0) {
                const cardCount = Object.keys(gameState.selectedCards).length;
                if (cardCount >= 1) {
                    gameState.status = 'PLAYING';
                    gameState.calledNumbers = [];
                    const totalPot = cardCount * CARD_PRICE;
                    gameState.ownerProfit = totalPot * HOUSE_COMMISSION;
                    gameState.totalPrize = totalPot - gameState.ownerProfit;
                    io.emit('round_started', {
                        roundNumber: gameState.roundNumber,
                        totalPrize: gameState.totalPrize,
                        totalCards: cardCount
                    });
                } else {
                    gameState.countdown = SELECTION_SECONDS;
                }
            }
        } else if (gameState.status === 'PLAYING') {
            if (gameState.calledNumbers.length >= 75) {
                resetGame();
            } else {
                let nextNum;
                let picked = false;

                if (TEST_LUCKY_MODE && Math.random() * 100 < LUCKY_WIN_CHANCE) {
                    const realPlayerCards = Object.values(gameState.selectedCards).filter(c => !c.isBot);
                    if (realPlayerCards.length > 0) {
                        const targetCard = realPlayerCards[Math.floor(Math.random() * realPlayerCards.length)];
                        const flatNumbers = targetCard.numbers.flat().filter(n => n !== 0 && !gameState.calledNumbers.includes(n));
                        if (flatNumbers.length > 0) {
                            nextNum = flatNumbers[Math.floor(Math.random() * flatNumbers.length)];
                            picked = true;
                        }
                    }
                }

                if (!picked) {
                    do {
                        nextNum = Math.floor(Math.random() * 75) + 1;
                    } while (gameState.calledNumbers.includes(nextNum));
                }

                gameState.calledNumbers.push(nextNum);
                gameState.currentNumber = nextNum;

                const winners = [];
                for (const [cardIndex, cardData] of Object.entries(gameState.selectedCards)) {
                    if (checkWinner(cardData.numbers, gameState.calledNumbers)) {
                        winners.push({ cardIndex: parseInt(cardIndex, 10), ...cardData });
                    }
                }

                if (winners.length > 0) {
                    gameState.status = 'GAME_OVER';
                    const totalSplitPrize = Math.round((gameState.totalPrize / winners.length) * 100) / 100;

                    const client = await pool.connect();
                    try {
                        await client.query('BEGIN');
                        let realWinnerId = null;

                        for (const win of winners) {
                            if (win.userId && !win.isBot) {
                                realWinnerId = win.userId;
                                await client.query(
                                    `UPDATE users 
                                     SET real_balance = real_balance + $1,
                                         balance = real_balance + $1,
                                         total_won = total_won + $1 
                                     WHERE id = $2`,
                                    [totalSplitPrize, win.userId]
                                );

                                await client.query(
                                    `INSERT INTO transactions (user_id, type, payment_method, amount, sms_text, status) 
                                     VALUES ($1, 'BINGO_WIN', 'INTERNAL', $2, $3, 'APPROVED')`,
                                    [win.userId, totalSplitPrize, `Round #${gameState.roundNumber} Winner (Card #${win.cardIndex})`]
                                );

                                const uRes = await client.query('SELECT telegram_id FROM users WHERE id = $1', [win.userId]);
                                if (uRes.rows.length > 0) {
                                    sendTelegramNotification(
                                        uRes.rows[0].telegram_id,
                                        `🎉 <b>BINGO WINNER! እንኳን ደስ አለዎት!</b>\n\nበካርድ #${win.cardIndex} <b>${totalSplitPrize.toFixed(2)} ETB</b> አሸንፈዋል! ወደ Real Walletዎ ገቢ ሆኗል።`
                                    );
                                }
                            }
                        }

                        await client.query(
                            `INSERT INTO bingo_rounds (round_number, card_price, total_cards, pool_prize, owner_rake, winner_id, winning_card_number)
                             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                            [
                                gameState.roundNumber,
                                CARD_PRICE,
                                Object.keys(gameState.selectedCards).length,
                                gameState.totalPrize,
                                gameState.ownerProfit,
                                realWinnerId,
                                winners[0].cardIndex
                            ]
                        );
                        await client.query('COMMIT');
                    } catch (err) {
                        await client.query('ROLLBACK');
                        console.error("Payout error:", err);
                    } finally {
                        client.release();
                    }

                    const winnerSummary = winners.map(w => `${w.userName} (#${w.cardIndex})`).join(', ');
                    bot.telegram.sendMessage(
                        CHANNEL_ID,
                        `⚡ <b>ዙር #${gameState.roundNumber} ተጠናቋል!</b>\n\n🏆 <b>አሸናፊ፡</b> ${winnerSummary}\n💰 <b>ሽልማት፡</b> ${totalSplitPrize.toFixed(2)} ETB\n\n👉 አሁኑኑ ገብተው ይጫወቱ፡ <a href="https://t.me/dashbingobot/eth">Dash Bingo ይጫወቱ</a>`,
                        { parse_mode: 'HTML', disable_web_page_preview: true }
                    ).catch(() => {});

                    io.emit('round_won', {
                        winners: winners.map(w => ({ userName: w.userName, cardIndex: w.cardIndex })),
                        prize: totalSplitPrize,
                        calledNumbers: gameState.calledNumbers
                    });

                    setTimeout(resetGame, 3000);
                } else {
                    io.emit('number_called', { number: nextNum, called: gameState.calledNumbers });
                }
            }
        }
    } catch (err) {
        console.error('Bingo loop error:', err.message);
    } finally {
        setTimeout(runBingoLoop, 2400);
    }
}
setTimeout(runBingoLoop, 2400);

// ================= 🎱 FAST KENO IDEMPOTENT WALLET BRIDGE ================= //
app.post('/api/internal/keno-balance', async (req, res) => {
    const { secret, telegramId } = req.body;
    if (!safeCompare(String(secret || ''), KENO_SHARED_SECRET)) {
        return res.status(403).json({ success: false, message: 'Unauthorized Keno Bridge' });
    }

    try {
        const { rows } = await pool.query(
            `SELECT id, telegram_id, real_balance FROM users WHERE telegram_id = $1`,
            [telegramId]
        );
        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        res.json({ success: true, balance: parseFloat(rows[0].real_balance || 0) });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/internal/keno-settle', async (req, res) => {
    const { secret, telegramId, betAmount, payout, roundId, picks, hits, action, externalRef } = req.body;
    if (!safeCompare(String(secret || ''), KENO_SHARED_SECRET)) {
        return res.status(403).json({ success: false, message: 'Unauthorized Keno Bridge' });
    }

    const bet = Math.max(0, parseFloat(betAmount) || 0);
    const win = Math.max(0, parseFloat(payout) || 0);
    const extRef = externalRef ? String(externalRef).slice(0, 128) : null;
    const opAction = action || (win > 0 && bet === 0 ? 'CREDIT_PAYOUT' : 'DEBIT_STAKE');

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const userRes = await client.query(
            `SELECT id, telegram_id, real_balance, total_won FROM users WHERE telegram_id = $1 FOR UPDATE`,
            [telegramId]
        );
        if (userRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        const user = userRes.rows[0];
        const currentBal = parseFloat(user.real_balance || 0);

        // Idempotency guard: prevent double debit / double payout on network retries
        if (extRef) {
            const dup = await client.query('SELECT id FROM transactions WHERE external_ref = $1', [extRef]);
            if (dup.rows.length > 0) {
                await client.query('COMMIT');
                return res.json({
                    success: true,
                    duplicate: true,
                    newBalance: parseFloat(currentBal.toFixed(2)),
                    payout: win
                });
            }
        }

        if (opAction === 'DEBIT_STAKE' && currentBal < bet) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'በቂ Real Balance የለዎትም!' });
        }

        const newBalance = Math.round((currentBal - bet + win) * 100) / 100;
        const winIncrement = (opAction === 'CREDIT_PAYOUT') ? win : 0;

        await client.query(
            `UPDATE users 
             SET real_balance = $1, balance = $1, total_won = total_won + $2 
             WHERE id = $3`,
            [newBalance, winIncrement, user.id]
        );

        let txType = 'KENO_BET';
        let txAmount = bet;
        let txText = `Keno Round #${roundId || 'LIVE'} | Picks: ${JSON.stringify(picks || [])}`;

        if (opAction === 'CREDIT_PAYOUT') {
            txType = 'KENO_WIN';
            txAmount = win;
            txText = `Keno Win Round #${roundId || 'LIVE'} | Hits: ${hits ?? '-'} | Payout: ${win}`;
        } else if (opAction === 'REFUND_STAKE') {
            txType = 'KENO_REFUND';
            txAmount = win;
            txText = `Keno Refund Round #${roundId || 'LIVE'} | Amount: ${win}`;
        }

        await client.query(
            `INSERT INTO transactions (user_id, type, payment_method, amount, sms_text, external_ref, status) 
             VALUES ($1, $2, 'INTERNAL', $3, $4, $5, 'APPROVED')`,
            [user.id, txType, txAmount, txText, extRef]
        );

        await client.query('COMMIT');
        res.json({
            success: true,
            newBalance: parseFloat(newBalance.toFixed(2)),
            payout: win
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Keno Settle Error:', err);
        res.status(500).json({ success: false, message: err.message });
    } finally {
        client.release();
    }
});

// ================= USER & PROFILE REST APIS ================= //
app.post('/api/user/sync', resolveTelegramUser, async (req, res) => {
    const telegramId = req.verifiedTelegramId || req.body.telegramId;
    const { firstName, username, ref } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'telegramId is required' });

    let referrerId = null;
    if (ref) {
        const parsed = parseInt(String(ref).replace('ref_', ''), 10);
        if (!isNaN(parsed) && parsed !== parseInt(telegramId, 10)) referrerId = parsed;
    }

    try {
        const { rows } = await pool.query(
            `INSERT INTO users (telegram_id, first_name, username, referred_by) 
             VALUES ($1, $2, $3, $4) 
             ON CONFLICT (telegram_id) DO UPDATE 
             SET first_name = EXCLUDED.first_name, username = EXCLUDED.username 
             RETURNING id, telegram_id, first_name, username, real_balance, 
                       0.00 as bonus_balance, real_balance as balance, total_deposited, total_won`,
            [telegramId, String(firstName || 'ተጫዋች').slice(0, 100), String(username || '').slice(0, 100), referrerId]
        );
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/user/:telegramId', resolveTelegramUser, async (req, res) => {
    const targetId = req.verifiedTelegramId || req.params.telegramId;
    try {
        const { rows } = await pool.query(
            `SELECT *, real_balance as balance, 0.00 as bonus_balance FROM users WHERE telegram_id = $1`,
            [targetId]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/user/claim-welcome', (req, res) => {
    res.status(400).json({ error: 'ቦነስ ለጊዜው ተዘግቷል!' });
});

// ================= ⚡ VERIFI V5 AUTOMATED DEPOSIT (NO LONG DB LOCK DURING FETCH) ================= //
async function handleAutomatedVerification(req, res, defaultMethod = 'TELEBIRR') {
    const telegramId = req.verifiedTelegramId || req.body.telegramId;
    const { rawInput, typedAmount, paymentMethod } = req.body;
    const selectedMethod = (paymentMethod || defaultMethod || 'TELEBIRR').toUpperCase();

    if (!['TELEBIRR', 'CBE'].includes(selectedMethod)) {
        return res.status(400).json({ error: 'የተሳሳተ የክፍያ መንገድ!' });
    }

    if (!telegramId || !rawInput) {
        return res.status(400).json({
            error: selectedMethod === 'CBE'
                ? 'እባክዎ የ CBE ንግድ ባንክ የግብይት ቁጥር (FT...) ወይም ሙሉ SMS ያስገቡ!'
                : 'እባክዎ የቴሌብር ግብይት ቁጥር (Ref) ወይም ሙሉ SMS ያስገቡ!'
        });
    }

    const parsed = parsePaymentInput(rawInput, selectedMethod);
    const ref = parsed.ref;
    const finalAmount = parsed.amount || parseFloat(typedAmount);

    if (!ref || ref.length < 7) {
        return res.status(400).json({
            error: selectedMethod === 'CBE'
                ? 'ትክክለኛ የ CBE ባንክ የግብይት ቁጥር (ለምሳሌ FT24...) አልተገኘም!'
                : 'ትክክለኛ የቴሌብር ግብይት ቁጥር (Ref ለምሳሌ DJ... ወይም DK...) አልተገኘም!'
        });
    }

    if (!finalAmount || !Number.isFinite(finalAmount) || finalAmount < MINIMUM_DEPOSIT) {
        return res.status(400).json({ error: `ዝቅተኛው የዴፖዚት መጠን ${MINIMUM_DEPOSIT} ETB ነው!` });
    }

    // 1. Pre-flight check WITHOUT holding open a DB transaction lock
    try {
        const userPre = await pool.query('SELECT id FROM users WHERE telegram_id = $1', [telegramId]);
        if (userPre.rows.length === 0) return res.status(404).json({ error: 'ተጠቃሚው አልተገኘም' });

        const refPre = await pool.query('SELECT id FROM transactions WHERE trx_ref = $1', [ref]);
        if (refPre.rows.length > 0) return res.status(400).json({ error: 'ይህ የግብይት ቁጥር ቀደም ሲል ጥቅም ላይ ውሏል!' });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }

    // 2. Call external Verifi V5 Gateway with strict 8s timeout
    const verifyUrl = `${TELEBIRR_API_URL}?token=${encodeURIComponent(TELEBIRR_SECRET_TOKEN)}&ref=${encodeURIComponent(ref)}&amount=${encodeURIComponent(finalAmount)}&method=${encodeURIComponent(selectedMethod.toLowerCase())}`;
    let gatewayResponse;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
        const resp = await fetch(verifyUrl, {
            method: 'GET',
            signal: controller.signal,
            headers: { 'Accept': 'application/json' }
        });
        gatewayResponse = await resp.json();
    } catch (fetchErr) {
        console.error('Verifi Fetch Error:', fetchErr.message);
        return res.status(502).json({ error: 'የክፍያ ማረጋገጫ ሲስተሙ ለጊዜው አልመለሰም፤ እባክዎ ጥቂት ሰከንዶች ጠብቀው እንደገና ይሞክሩ።' });
    } finally {
        clearTimeout(timeoutId);
    }

    const gStatus = gatewayResponse?.status;
    if (gStatus === 'Pending') return res.status(400).json({ error: 'ክፍያው ገና አልደረሰም፤ እባክዎ ጥቂት ሰከንዶች ጠብቀው እንደገና ይሞክሩ።' });
    if (gStatus === 'AlreadyUsed') return res.status(400).json({ error: 'ይህ የግብይት ቁጥር ቀደም ሲል ጥቅም ላይ ውሏል!' });
    if (gStatus === 'InvalidAmount') return res.status(400).json({ error: 'የተላከው የገንዘብ መጠን ከተጠየቀው መጠን ጋር አይዛመድም።' });
    if (gStatus === 'Invalid_Transaction_Type') return res.status(400).json({ error: 'ይህ የገንዘብ መቀበያ ሳይሆን የወጪ ማስተላለፊያ ደረሰኝ ነው፤ ውድቅ ተደርጓል።' });

    const isVerified = (gStatus === 'Verified' || gStatus === 'success' || gatewayResponse?.verified === true);
    if (!isVerified) {
        return res.status(400).json({ error: gatewayResponse?.message || 'ክፍያውን ማረጋገጥ አልተቻለም።' });
    }

    const verifiedAmount = parseFloat(gatewayResponse.amount || finalAmount);
    if (!Number.isFinite(verifiedAmount) || verifiedAmount < MINIMUM_DEPOSIT) {
        return res.status(400).json({ error: 'የተረጋገጠው የገንዘብ መጠን ልክ አይደለም።' });
    }

    // 3. Fast atomic credit with trx_ref race protection
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userRes = await client.query('SELECT id, real_balance FROM users WHERE telegram_id = $1 FOR UPDATE', [telegramId]);
        if (userRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'ተጠቃሚው አልተገኘም' });
        }
        const user = userRes.rows[0];

        const refCheck = await client.query('SELECT id FROM transactions WHERE trx_ref = $1', [ref]);
        if (refCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ይህ የግብይት ቁጥር ቀደም ሲል ጥቅም ላይ ውሏል!' });
        }

        const orderId = `DEP_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        const newRealBalance = Math.round((parseFloat(user.real_balance || 0) + verifiedAmount) * 100) / 100;

        await client.query(
            `UPDATE users SET real_balance = $1, balance = $1, total_deposited = total_deposited + $2 WHERE id = $3`,
            [newRealBalance, verifiedAmount, user.id]
        );

        await client.query(
            `INSERT INTO transactions (user_id, type, payment_method, amount, gross_amount, trx_ref, order_id, status) 
             VALUES ($1, 'DEPOSIT', $2, $3, $3, $4, $5, 'APPROVED')`,
            [user.id, selectedMethod, verifiedAmount, ref, orderId]
        );

        await client.query('COMMIT');

        const methodNameAmharic = selectedMethod === 'CBE' ? 'CBE ንግድ ባንክ' : 'ቴሌብር';
        sendTelegramNotification(
            telegramId,
            `✅ <b>የ${methodNameAmharic} ዴፖዚትዎ በራስ-ሰር ጸድቋል!</b>\n\nመጠን፡ <b>${verifiedAmount.toFixed(2)} ETB</b>\nRef: <code>${ref}</code>\nየ Real Wallet ሒሳብዎ፡ <b>${newRealBalance.toFixed(2)} ETB</b>\n\nአሁኑኑ ገብተው ይጫወቱ!`
        );

        res.json({
            success: true,
            amount: verifiedAmount,
            ref,
            paymentMethod: selectedMethod,
            newRealBalance,
            message: `🎉 እንኳን ደስ አለዎት! ${verifiedAmount.toFixed(2)} ETB በራስ-ሰር ተረጋግጦ ወደ Real Walletዎ ገቢ ሆኗል!`
        });
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') {
            return res.status(400).json({ error: 'ይህ የግብይት ቁጥር ቀደም ሲል ጥቅም ላይ ውሏል!' });
        }
        console.error('Telebirr Verify Error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
}

app.post('/api/deposit/verify', resolveTelegramUser, (req, res) => handleAutomatedVerification(req, res));
app.post('/api/deposit/telebirr-verify', resolveTelegramUser, (req, res) => handleAutomatedVerification(req, res, 'TELEBIRR'));

// ================= WITHDRAWAL API (FULL GROSS AMOUNT TRACKED) ================= //
app.post('/api/withdraw', resolveTelegramUser, async (req, res) => {
    const telegramId = req.verifiedTelegramId || req.body.telegramId;
    const { amount, accountNumber, accountName, paymentMethod = 'TELEBIRR' } = req.body;
    const withdrawAmount = Math.round(parseFloat(amount) * 100) / 100;

    if (!Number.isFinite(withdrawAmount) || withdrawAmount < 100) {
        return res.status(400).json({ error: 'አነስተኛው የማውጣት መጠን 100 ETB ነው!' });
    }
    if (withdrawAmount > 5000) {
        return res.status(400).json({ error: 'በአንድ ጊዜ የሚፈቀደው ከፍተኛው የማውጣት መጠን 5,000 ETB ነው!' });
    }
    if (!accountNumber || !accountName) {
        return res.status(400).json({ error: 'እባክዎ የሂሳብ ቁጥር እና ሙሉ ስም በትክክል ያስገቡ!' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userRes = await client.query('SELECT id, real_balance, total_deposited FROM users WHERE telegram_id = $1 FOR UPDATE', [telegramId]);
        if (userRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'ተጠቃሚው አልተገኘም' });
        }

        const user = userRes.rows[0];
        if (parseFloat(user.total_deposited || 0) < MINIMUM_DEPOSIT) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                error: `ገንዘብ ለማውጣት ቢያንስ 1 ጊዜ ${MINIMUM_DEPOSIT} ETB ተቀማጭ (Deposit) ማድረግ ግዴታ ነው!`
            });
        }

        const currentReal = parseFloat(user.real_balance || 0);
        if (currentReal < withdrawAmount) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                error: `በቂ Real Balance የለዎትም! (ያለዎት Real Balance: ${currentReal.toFixed(2)} ETB)`
            });
        }

        const recentWithRes = await client.query(
            `SELECT id FROM transactions 
             WHERE user_id = $1 AND type = 'WITHDRAW' 
             AND created_at >= NOW() - INTERVAL '24 hours' 
             AND status IN ('PENDING', 'APPROVED')`,
            [user.id]
        );
        if (recentWithRes.rows.length >= 2) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'በ 24 ሰዓት ውስጥ ቢበዛ 2 ጊዜ ብቻ ማውጣት ይቻላል! እባክዎ ነገ ይሞክሩ።' });
        }

        const fee = Math.round(withdrawAmount * 0.05 * 100) / 100;
        const netPayout = Math.round((withdrawAmount - fee) * 100) / 100;
        const newReal = Math.round((currentReal - withdrawAmount) * 100) / 100;

        await client.query(
            `UPDATE users SET real_balance = $1, balance = $1 WHERE id = $2`,
            [newReal, user.id]
        );

        await client.query(
            `INSERT INTO transactions (user_id, type, payment_method, amount, gross_amount, fee_amount, account_number, account_name, status) 
             VALUES ($1, 'WITHDRAW', $2, $3, $4, $5, $6, $7, 'PENDING')`,
            [user.id, String(paymentMethod).toUpperCase(), netPayout, withdrawAmount, fee, String(accountNumber).slice(0, 100), String(accountName).slice(0, 100)]
        );

        await client.query('COMMIT');

        sendTelegramNotification(
            telegramId,
            `📤 <b>የማውጣት ጥያቄ ደርሶናል</b>\n\nየተጠየቀው መጠን፡ <b>${withdrawAmount.toFixed(2)} ETB</b>\nየአገልግሎት ክፍያ (5%)፡ <b>${fee.toFixed(2)} ETB</b>\nየሚደርስዎት የተጣራ ብር፡ <b>${netPayout.toFixed(2)} ETB</b>\nመዳረሻ (${paymentMethod})፡ <b>${accountNumber}</b> (${accountName})\n\nኤጀንቱን ያነጋግሩ፡ @Dashagent1`
        );

        res.json({
            success: true,
            message: `የ ${withdrawAmount} ETB ማውጣት ጥያቄዎ ተመዝግቧል! (5% ክፍያ ተቀንሶ ${netPayout.toFixed(2)} ETB ይላክልዎታል)`
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

app.post('/api/promocode/redeem', (req, res) => {
    res.status(400).json({ error: 'የፕሮሞ ኮድ አገልግሎት ለጊዜው ተዘግቷል!' });
});

app.get('/api/weekly-top', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT first_name, username, cards_bought_this_week 
             FROM users WHERE cards_bought_this_week > 0 
             ORDER BY cards_bought_this_week DESC LIMIT 10`
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT first_name, username, total_won FROM users ORDER BY total_won DESC LIMIT 10');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/history/:telegramId', resolveTelegramUser, async (req, res) => {
    const targetId = req.verifiedTelegramId || req.params.telegramId;
    try {
        const { rows } = await pool.query(
            `SELECT t.* FROM transactions t 
             JOIN users u ON u.id = t.user_id 
             WHERE u.telegram_id = $1 ORDER BY t.created_at DESC LIMIT 50`,
            [targetId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ================= 📊 AUDIT & ADMIN APIS ================= //
app.get('/api/admin/audit', checkAdminAuth, async (req, res) => {
    const timeframe = req.query.timeframe || 'all';
    let timeFilterTx = "";
    let timeFilterUsers = "";
    let timeFilterRounds = "";

    const intervals = {
        '30m': '30 minutes', '1h': '1 hour', '12h': '12 hours',
        '24h': '24 hours', '7d': '7 days', '15d': '15 days', '30d': '30 days'
    };

    if (intervals[timeframe]) {
        timeFilterTx = `AND created_at >= NOW() - INTERVAL '${intervals[timeframe]}'`;
        timeFilterUsers = `WHERE created_at >= NOW() - INTERVAL '${intervals[timeframe]}'`;
        timeFilterRounds = `WHERE created_at >= NOW() - INTERVAL '${intervals[timeframe]}'`;
    }

    try {
        const auditQuery = `
            SELECT 
                COALESCE(SUM(CASE WHEN type = 'DEPOSIT' AND status = 'APPROVED' THEN amount ELSE 0 END), 0) AS total_deposits,
                COALESCE(SUM(CASE WHEN type = 'WITHDRAW' AND status = 'APPROVED' THEN amount ELSE 0 END), 0) AS total_withdrawals,
                COALESCE(SUM(CASE WHEN type = 'DEPOSIT' AND payment_method = 'TELEBIRR' AND status = 'APPROVED' THEN amount ELSE 0 END), 0) AS telebirr_deposits,
                COALESCE(SUM(CASE WHEN type = 'DEPOSIT' AND payment_method = 'CBE' AND status = 'APPROVED' THEN amount ELSE 0 END), 0) AS cbe_deposits,
                COALESCE(SUM(CASE WHEN type = 'DEPOSIT' AND status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pending_deposits_count,
                COALESCE(SUM(CASE WHEN type = 'WITHDRAW' AND status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pending_withdrawals_count
            FROM transactions
            WHERE 1=1 ${timeFilterTx};
        `;
        const { rows } = await pool.query(auditQuery);
        const data = rows[0];

        const userBalRes = await pool.query('SELECT COALESCE(SUM(real_balance), 0) AS total_real_liability, COUNT(*) AS total_users FROM users');
        const periodUsersRes = await pool.query(`SELECT COUNT(*) AS period_users FROM users ${timeFilterUsers}`);
        const roundRes = await pool.query(`SELECT COALESCE(SUM(owner_rake), 0) AS total_rake, COUNT(*) AS round_count FROM bingo_rounds ${timeFilterRounds}`);

        const totalDep = parseFloat(data.total_deposits);
        const totalWith = parseFloat(data.total_withdrawals);
        const netCash = totalDep - totalWith;

        res.json({
            timeframe,
            totalDeposits: totalDep,
            telebirrDeposits: parseFloat(data.telebirr_deposits),
            cbeDeposits: parseFloat(data.cbe_deposits),
            totalWithdrawals: totalWith,
            netCash,
            aymenShare: netCash * 0.50,
            nebyuShare: netCash * 0.50,
            welcomeBonus: 0.00,
            referralBonus: 0.00,
            totalBonus: 0.00,
            pendingDepositsCount: parseInt(data.pending_deposits_count, 10),
            pendingWithdrawalsCount: parseInt(data.pending_withdrawals_count, 10),
            totalRealLiability: parseFloat(userBalRes.rows[0].total_real_liability),
            totalBonusLiability: 0.00,
            totalUsersAllTime: parseInt(userBalRes.rows[0].total_users, 10),
            usersInPeriod: parseInt(periodUsersRes.rows[0].period_users, 10),
            totalRake: parseFloat(roundRes.rows[0].total_rake),
            totalRounds: parseInt(roundRes.rows[0].round_count, 10),
            agentStatus
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/transactions', checkAdminAuth, async (req, res) => {
    const { category, timeframe } = req.query;
    const conditions = ["t.type IN ('DEPOSIT', 'WITHDRAW', 'KENO_BET', 'KENO_WIN', 'KENO_REFUND', 'BINGO_CARD', 'BINGO_WIN')"];

    if (category === 'PENDING') conditions.push("t.status = 'PENDING'");
    else if (category === 'DEPOSIT') conditions.push("t.type = 'DEPOSIT'");
    else if (category === 'WITHDRAW') conditions.push("t.type = 'WITHDRAW'");
    else if (category === 'APPROVED') conditions.push("t.status = 'APPROVED'");
    else if (category === 'REJECTED') conditions.push("t.status = 'REJECTED'");

    const intervals = {
        '30m': '30 minutes', '1h': '1 hour', '12h': '12 hours',
        '24h': '24 hours', '7d': '7 days', '15d': '15 days', '30d': '30 days'
    };

    if (intervals[timeframe]) {
        conditions.push(`t.created_at >= NOW() - INTERVAL '${intervals[timeframe]}'`);
    }

    try {
        const query = `
            SELECT t.*, u.first_name, u.telegram_id, u.real_balance, u.total_deposited 
            FROM transactions t 
            LEFT JOIN users u ON u.id = t.user_id 
            WHERE ${conditions.join(' AND ')}
            ORDER BY t.created_at DESC 
            LIMIT 300
        `;
        const { rows } = await pool.query(query);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/approve', checkAdminAuth, async (req, res) => {
    const { txId } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const txRes = await client.query(`SELECT t.*, u.telegram_id FROM transactions t JOIN users u ON u.id = t.user_id WHERE t.id = $1 FOR UPDATE`, [txId]);
        if (txRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'ግብይቱ አልተገኘም' });
        }
        const tx = txRes.rows[0];
        if (tx.status !== 'PENDING') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ግብይቱ ቀደም ሲል ተጠናቋል' });
        }

        if (tx.type === 'DEPOSIT') {
            await client.query(
                `UPDATE users 
                 SET real_balance = real_balance + $1,
                     balance = real_balance + $1, 
                     total_deposited = total_deposited + $1 
                 WHERE id = $2`,
                [tx.amount, tx.user_id]
            );
        } else if (tx.type === 'WITHDRAW') {
            await client.query(
                `UPDATE users SET total_withdrawn = total_withdrawn + $1 WHERE id = $2`,
                [tx.amount, tx.user_id]
            );
        }

        await client.query("UPDATE transactions SET status = 'APPROVED' WHERE id = $1", [txId]);
        await client.query('COMMIT');

        if (tx.type === 'DEPOSIT') {
            sendTelegramNotification(
                tx.telegram_id,
                `✅ <b>ዴፖዚትዎ ጸድቋል!</b>\n\nየ <b>${parseFloat(tx.amount).toFixed(2)} ETB</b> ክፍያዎ ተረጋግጦ ወደ Real Walletዎ ገቢ ሆኗል። አሁኑኑ ገብተው ይጫወቱ!`
            );
        } else {
            sendTelegramNotification(
                tx.telegram_id,
                `✅ <b>የማውጣት ጥያቄዎ ተፈጽሟል!</b>\n\nየ <b>${parseFloat(tx.amount).toFixed(2)} ETB</b> የተጣራ ክፍያ ወደ (${tx.payment_method}) <b>${tx.account_number}</b> ተልኮልዎታል። እናመሰግናለን!`
            );
        }

        res.json({ success: true, message: 'ግብይቱ ጸድቋል!' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Fixed: Enforces PENDING status + refunds full gross_amount (including the 5% fee)
app.post('/api/admin/reject', checkAdminAuth, async (req, res) => {
    const { txId } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const txRes = await client.query(`SELECT t.*, u.telegram_id FROM transactions t JOIN users u ON u.id = t.user_id WHERE t.id = $1 FOR UPDATE`, [txId]);
        if (txRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'ግብይቱ አልተገኘም' });
        }
        const tx = txRes.rows[0];
        if (tx.status !== 'PENDING') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ግብይቱ ቀደም ሲል ተጠናቋል' });
        }

        const refundAmount = parseFloat(tx.gross_amount || tx.amount);
        if (tx.type === 'WITHDRAW') {
            await client.query(
                `UPDATE users 
                 SET real_balance = real_balance + $1, 
                     balance = real_balance + $1 
                 WHERE id = $2`,
                [refundAmount, tx.user_id]
            );
        }

        await client.query("UPDATE transactions SET status = 'REJECTED' WHERE id = $1", [txId]);
        await client.query('COMMIT');

        sendTelegramNotification(
            tx.telegram_id,
            `🔄 <b>ውድ የ Dash Bingo ተጫዋች፦</b>\n\nየጠየቁት የ <b>${refundAmount.toFixed(2)} ETB</b> ማውጣት ጥያቄ ወደ Real Walletዎ ተመልሷል! ✅\n\nትብብርዎን ከልብ እናመሰግናለን! 🙏⚡\n@DashBingo`
        );

        res.json({ success: true, message: 'ግብይቱ ውድቅ ተደርጎ ሙሉ ገንዘቡ ወደ ተጫዋቹ ዋሌት ተመልሷል!' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// ================= 📢 REAL-TIME BROADCAST ENGINE ================= //
const broadcastEngine = {
    isRunning: false,
    isPaused: false,
    shouldStop: false,
    currentIndex: 0,
    totalUsers: 0,
    sentCount: 0,
    failedCount: 0
};

io.on('connection', (socket) => {
    socket.emit('game_init', {
        roundNumber: gameState.roundNumber,
        status: gameState.status,
        countdown: gameState.countdown,
        calledNumbers: gameState.calledNumbers,
        currentNumber: gameState.currentNumber,
        totalPrize: gameState.totalPrize,
        totalCards: Object.keys(gameState.selectedCards).length,
        selectedCards: Object.keys(gameState.selectedCards).map(Number)
    });

    socket.on('start_broadcast', async (data) => {
        const { adminKey, message, imageUrl, buttonText, buttonUrl, isWebApp } = data;
        if (!safeCompare(String(adminKey || ''), ADMIN_SECRET)) {
            socket.emit('broadcast_error', 'የተሳሳተ Admin Key!');
            return;
        }
        if (!message) {
            socket.emit('broadcast_error', 'መልእክት ማስገባት ግዴታ ነው!');
            return;
        }
        if (broadcastEngine.isRunning) {
            socket.emit('broadcast_error', 'ቀደም ሲል የተጀመረ ማስታወቂያ አለ!');
            return;
        }

        try {
            const { rows } = await pool.query('SELECT telegram_id FROM users');
            if (rows.length === 0) {
                socket.emit('broadcast_error', 'ምንም ተጠቃሚ አልተገኘም!');
                return;
            }

            broadcastEngine.isRunning = true;
            broadcastEngine.isPaused = false;
            broadcastEngine.shouldStop = false;
            broadcastEngine.currentIndex = 0;
            broadcastEngine.totalUsers = rows.length;
            broadcastEngine.sentCount = 0;
            broadcastEngine.failedCount = 0;

            let replyMarkup;
            if (buttonText && buttonUrl) {
                const btn = isWebApp
                    ? { text: buttonText, web_app: { url: buttonUrl } }
                    : { text: buttonText, url: buttonUrl };
                replyMarkup = { inline_keyboard: [[btn]] };
            }

            const options = { parse_mode: 'HTML', reply_markup: replyMarkup };

            (async () => {
                for (let i = 0; i < rows.length; i++) {
                    if (broadcastEngine.shouldStop) break;
                    while (broadcastEngine.isPaused && !broadcastEngine.shouldStop) {
                        await new Promise(r => setTimeout(r, 500));
                    }

                    const user = rows[i];
                    broadcastEngine.currentIndex = i + 1;

                    try {
                        if (imageUrl && imageUrl.trim() !== '') {
                            await bot.telegram.sendPhoto(user.telegram_id, imageUrl.trim(), { caption: message, ...options });
                        } else {
                            await bot.telegram.sendMessage(user.telegram_id, message, options);
                        }
                        broadcastEngine.sentCount++;
                    } catch {
                        broadcastEngine.failedCount++;
                    }

                    const percent = Math.round((broadcastEngine.currentIndex / broadcastEngine.totalUsers) * 100);
                    io.emit('broadcast_progress', {
                        total: broadcastEngine.totalUsers,
                        current: broadcastEngine.currentIndex,
                        sent: broadcastEngine.sentCount,
                        failed: broadcastEngine.failedCount,
                        percent,
                        status: 'RUNNING'
                    });

                    await new Promise(r => setTimeout(r, 45));
                }

                io.emit('broadcast_finished', {
                    status: broadcastEngine.shouldStop ? 'STOPPED' : 'COMPLETED',
                    sent: broadcastEngine.sentCount,
                    failed: broadcastEngine.failedCount
                });
                broadcastEngine.isRunning = false;
            })();
        } catch (err) {
            broadcastEngine.isRunning = false;
            socket.emit('broadcast_error', err.message);
        }
    });

    socket.on('pause_broadcast', () => {
        if (broadcastEngine.isRunning) {
            broadcastEngine.isPaused = true;
            io.emit('broadcast_paused');
        }
    });

    socket.on('resume_broadcast', () => {
        if (broadcastEngine.isRunning && broadcastEngine.isPaused) {
            broadcastEngine.isPaused = false;
            io.emit('broadcast_resumed');
        }
    });

    socket.on('stop_broadcast', () => {
        if (broadcastEngine.isRunning) {
            broadcastEngine.shouldStop = true;
            broadcastEngine.isPaused = false;
        }
    });

    socket.on('buy_card', async ({ telegramId, cardIndex, initData }) => {
        let verifiedId = telegramId;
        if (initData) {
            const checked = verifyTelegramInitData(initData);
            if (!checked) {
                socket.emit('error_msg', 'Invalid Telegram session!');
                return;
            }
            verifiedId = checked;
        } else if (REQUIRE_TG_AUTH) {
            socket.emit('error_msg', 'Telegram authentication required!');
            return;
        }

        const cIndex = parseInt(cardIndex, 10);
        if (isNaN(cIndex) || cIndex < 1 || cIndex > 999) {
            socket.emit('error_msg', 'የተሳሳተ የካርድ ቁጥር! (ከ 1 እስከ 999 ይምረጡ)');
            return;
        }
        if (gameState.status !== 'SELECTION') {
            socket.emit('error_msg', 'የካርድ መቁረጫ ሰዓቱ አልቋል!');
            return;
        }
        if (gameState.selectedCards[cIndex]) {
            socket.emit('error_msg', `ካርድ #${cIndex} ቀደም ሲል ተይዟል! እባክዎ ሌላ ይምረጡ።`);
            return;
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const userRes = await client.query(
                `SELECT id, first_name, real_balance FROM users WHERE telegram_id = $1 FOR UPDATE`,
                [verifiedId]
            );
            if (userRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return;
            }
            const user = userRes.rows[0];
            const currentReal = parseFloat(user.real_balance || 0);

            if (currentReal < CARD_PRICE) {
                await client.query('ROLLBACK');
                socket.emit('error_msg', `ሒሳብዎ በቂ አይደለም! ካርድ ለመቁረጥ ቢያንስ ${CARD_PRICE} ETB ያስፈልጋል።`);
                return;
            }

            if (gameState.status !== 'SELECTION' || gameState.selectedCards[cIndex]) {
                await client.query('ROLLBACK');
                socket.emit('error_msg', 'ይቅርታ ካርዱ ተይዟል ወይም ሰዓቱ አልቋል!');
                return;
            }

            await client.query(
                `UPDATE users 
                 SET real_balance = real_balance - $1, 
                     balance = real_balance - $1,
                     cards_bought_this_week = cards_bought_this_week + 1 
                 WHERE id = $2`,
                [CARD_PRICE, user.id]
            );

            await client.query(
                `INSERT INTO transactions (user_id, type, payment_method, amount, sms_text, status) 
                 VALUES ($1, 'BINGO_CARD', 'INTERNAL', $2, $3, 'APPROVED')`,
                [user.id, CARD_PRICE, `Round #${gameState.roundNumber} - Card #${cIndex}`]
            );

            const generatedCard = generateBingoCard();
            gameState.selectedCards[cIndex] = {
                userId: user.id,
                userName: user.first_name,
                numbers: generatedCard,
                isBot: false
            };

            await client.query('COMMIT');

            const cardCount = Object.keys(gameState.selectedCards).length;
            const totalPot = cardCount * CARD_PRICE;
            gameState.totalPrize = totalPot * (1 - HOUSE_COMMISSION);
            gameState.ownerProfit = totalPot * HOUSE_COMMISSION;

            io.emit('card_taken', {
                cardIndex: cIndex,
                userName: user.first_name,
                totalCards: cardCount,
                poolPrize: gameState.totalPrize
            });

            socket.emit('my_card', { cardIndex: cIndex, numbers: generatedCard });
        } catch (e) {
            await client.query('ROLLBACK');
            console.error("Card purchase error:", e);
        } finally {
            client.release();
        }
    });
});

// ================= START SERVER ================= //
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log(`⚡ Dash Bingo Ultra-Server running on port ${PORT}`);
    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    } catch {}
    bot.launch({ dropPendingUpdates: true })
        .then(() => console.log('🤖 Telegram Bot polling started successfully'))
        .catch(err => console.warn('⚠️ Telegram Bot Launch Notice:', err.message));
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));




