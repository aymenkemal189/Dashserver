require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const { Telegraf, Markup } = require('telegraf');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(__dirname));

// ================= DATABASE CONNECTION (NEON POSTGRES) ================= //
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 30,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
    console.error('Neon DB Pool Error:', err);
});

// ================= STATIC ROUTES ================= //
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ================= ADMIN AUTH ================= //
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'super_secret_dash_admin_2026';
function checkAdminAuth(req, res, next) {
    const key = req.headers['x-admin-key'] || req.query.admin_key;
    if (key !== ADMIN_SECRET) {
        return res.status(403).json({ error: 'ያልተፈቀደ መዳረሻ! የተሳሳተ የአድሚን ቁልፍ።' });
    }
    next();
}

// ================= FAST KENO INTERNAL BRIDGE SECRET ================= //
const KENO_SHARED_SECRET = process.env.KENO_SHARED_SECRET || 'FAST_KENO_DASH_SECRET_KEY_2026';

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
const TELEBIRR_API_URL = process.env.TELEBIRR_API_URL || 'https://verifi-server.onrender.com/api/verify';
const TELEBIRR_SECRET_TOKEN = process.env.TELEBIRR_SECRET_TOKEN || 'Verifi_Prod_9842_Aymen_X9!2026';
const MINIMUM_DEPOSIT = 50;

function parseTelebirrInput(input) {
    const text = String(input || '').trim();
    let ref = null;
    let amount = null;

    const djMatch = text.match(/\b(DJ[A-Z0-9]{8,12})\b/i);
    if (djMatch) {
        ref = djMatch[1].toUpperCase();
    } else {
        const genericMatch = text.match(/transaction\s*(?:number|id|ref|no)?\s*(?:is|:)?\s*([A-Z0-9]{8,14})/i);
        if (genericMatch) {
            ref = genericMatch[1].toUpperCase();
        } else if (/^[A-Z0-9]{8,14}$/i.test(text)) {
            ref = text.toUpperCase();
        }
    }

    const amtMatch = text.match(/(?:ETB|Birr)\s*([0-9]+(?:\.[0-9]{1,2})?)/i) || text.match(/\b([0-9]+(?:\.[0-9]{1,2})?)\s*(?:ETB|Birr|ብር)/i);
    if (amtMatch) {
        amount = parseFloat(amtMatch[1]);
    }

    return { ref, amount };
}

// ================= AGENT STATUS ================= //
let agentStatus = {
    telebirr: { name: "Dash Cashier", handle: "@Dashagent1", account: "0996910607", isOnline: true }
};

app.get('/api/agents/status', (req, res) => {
    res.json(agentStatus);
});

app.post('/api/admin/agents/toggle', checkAdminAuth, (req, res) => {
    const { isOnline } = req.body;
    agentStatus.telebirr.isOnline = Boolean(isOnline);
    res.json({ success: true, agentStatus });
});

// Bot Start
bot.start(async (ctx) => {
    const { id, first_name, username } = ctx.from;
    const startPayload = ctx.startPayload || '';

    let referrerId = null;
    if (startPayload.startsWith('ref_')) {
        const parsed = parseInt(startPayload.replace('ref_', ''));
        if (!isNaN(parsed) && parsed !== id) {
            referrerId = parsed;
        }
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
            `እንኳን ወደ <b>Dash Bingo ⚡ & Fast Keno</b> በደህና መጡ!\n\nቴሌብር ተቀማጭ በማድረግ አሁኑኑ መጫወት ይጀምሩ፦`, 
            {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([
                    [Markup.button.webApp("🎮 Play Dash Games", WEBAPP_URL)]
                ])
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
        let nums = [];
        while (nums.length < 5) {
            let r = Math.floor(Math.random() * (max - min + 1)) + min;
            if (!nums.includes(r)) nums.push(r);
        }
        return nums;
    };
    let b = getCols(1, 15);
    let i = getCols(16, 30);
    let n = getCols(31, 45);
    let g = getCols(46, 60);
    let o = getCols(61, 75);
    n[2] = 0; // Center Star (★)
    return [b, i, n, g, o];
}

function checkWinner(card, called) {
    const isMarked = (val) => val === 0 || called.includes(val);
    for (let c = 0; c < 5; c++) {
        if (card[c].every(isMarked)) return true;
    }
    for (let r = 0; r < 5; r++) {
        let rowWin = true;
        for (let c = 0; c < 5; c++) {
            if (!isMarked(card[c][r])) { rowWin = false; break; }
        }
        if (rowWin) return true;
    }
    let diag1 = true, diag2 = true;
    for (let i = 0; i < 5; i++) {
        if (!isMarked(card[i][i])) diag1 = false;
        if (!isMarked(card[i][4 - i])) diag2 = false;
    }
    return diag1 || diag2;
}

// Master Real-Time Game Loop
setInterval(async () => {
    if (gameState.status === 'SELECTION') {
        gameState.countdown--;
        io.emit('game_tick', { status: 'SELECTION', countdown: gameState.countdown });

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
            return;
        }

        let nextNum;
        do {
            nextNum = Math.floor(Math.random() * 75) + 1;
        } while (gameState.calledNumbers.includes(nextNum));

        gameState.calledNumbers.push(nextNum);
        gameState.currentNumber = nextNum;

        let winners = [];
        for (const [cardIndex, cardData] of Object.entries(gameState.selectedCards)) {
            if (checkWinner(cardData.numbers, gameState.calledNumbers)) {
                winners.push({ cardIndex: parseInt(cardIndex), ...cardData });
            }
        }

        if (winners.length > 0) {
            gameState.status = 'GAME_OVER';

            const totalSplitPrize = gameState.totalPrize / winners.length;

            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                for (const win of winners) {
                    if (win.userId) {
                        // አሸናፊው በቀጥታ ወደ እውነተኛ Real Balance ይገባል
                        await client.query(
                            `UPDATE users 
                             SET real_balance = real_balance + $1,
                                 balance = real_balance + $1 + bonus_balance,
                                 total_won = total_won + $1 
                             WHERE id = $2`,
                            [totalSplitPrize, win.userId]
                        );

                        const uRes = await client.query('SELECT telegram_id FROM users WHERE id = $1', [win.userId]);
                        if (uRes.rows.length > 0) {
                            sendTelegramNotification(
                                uRes.rows[0].telegram_id,
                                `🎉 <b>BINGO WINNER! እንኳን ደስ አለዎት!</b>\n\nበካርድ #${win.cardIndex} <b>${totalSplitPrize.toFixed(2)} ETB</b> አሸንፈዋል! ወደ ዋና ሒሳብዎ ገቢ ተደርጓል።`
                            );
                        }
                    }
                }

                await client.query(
                    `INSERT INTO bingo_rounds (round_number, card_price, total_cards, pool_prize, owner_rake, winner_id, winning_card_number)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [gameState.roundNumber, CARD_PRICE, Object.keys(gameState.selectedCards).length, gameState.totalPrize, gameState.ownerProfit, winners[0].userId, winners[0].cardIndex]
                );
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                console.error("Payout error:", err);
            } finally {
                client.release();
            }

            const winnerSummary = winners.map(w => `${w.userName} (#${w.cardIndex})`).join(', ');

            try {
                await bot.telegram.sendMessage(
                    CHANNEL_ID,
                    `⚡ <b>ዙር #${gameState.roundNumber} ተጠናቋል!</b>\n\n🏆 <b>አሸናፊ፡</b> ${winnerSummary}\n💰 <b>ሽልማት፡</b> ${totalSplitPrize.toFixed(2)} ETB\n\n👉 አሁኑኑ ገብተው ይጫወቱ፡ <a href="https://t.me/dashbingobot/eth">Dash Bingo ይጫወቱ</a>`,
                    { parse_mode: 'HTML', disable_web_page_preview: true }
                );
            } catch (err) {}

            io.emit('round_won', {
                winners: winners.map(w => ({ userName: w.userName, cardIndex: w.cardIndex })),
                prize: totalSplitPrize,
                calledNumbers: gameState.calledNumbers
            });

            setTimeout(() => {
                resetGame();
            }, 3000);
        } else {
            io.emit('number_called', {
                number: nextNum,
                called: gameState.calledNumbers
            });
        }
    }
}, 2400);

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

// ================= 🎱 FAST KENO WALLET SYNC (ZERO LEAK BRIDGE) ================= //

app.post('/api/internal/keno-balance', async (req, res) => {
    const { secret, telegramId } = req.body;
    if (secret !== KENO_SHARED_SECRET) {
        return res.status(403).json({ success: false, message: 'Unauthorized Bridge' });
    }

    try {
        const { rows } = await pool.query(
            `SELECT id, telegram_id, real_balance, bonus_balance, (real_balance + bonus_balance) as playable 
             FROM users WHERE telegram_id = $1`,
            [telegramId]
        );
        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        
        res.json({
            success: true,
            balance: parseFloat(rows[0].playable || 0),
            real_balance: parseFloat(rows[0].real_balance || 0)
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/internal/keno-settle', async (req, res) => {
    const { secret, telegramId, betAmount, payout, roundId, picks } = req.body;
    if (secret !== KENO_SHARED_SECRET) {
        return res.status(403).json({ success: false, message: 'Unauthorized Bridge' });
    }

    const bet = parseFloat(betAmount) || 0;
    const win = parseFloat(payout) || 0;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userRes = await client.query(
            `SELECT id, telegram_id, real_balance, bonus_balance, total_won 
             FROM users WHERE telegram_id = $1 FOR UPDATE`,
            [telegramId]
        );

        if (userRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const user = userRes.rows[0];
        let realBal = parseFloat(user.real_balance || 0);
        let bonusBal = parseFloat(user.bonus_balance || 0);
        const playable = realBal + bonusBal;

        if (playable < bet) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'በቂ ሒሳብ የለዎትም!' });
        }

        // መጀመሪያ ከ Real Balance ይቀንሳል፤ ካለቀ ከ Bonus ይቀንሳል
        if (realBal >= bet) {
            realBal -= bet;
        } else {
            const remainder = bet - realBal;
            realBal = 0;
            bonusBal = Math.max(0, bonusBal - remainder);
        }

        // 🛡️ አሸናፊ ትርፍ በቀጥታ ወደ Real Balance ብቻ ይገባል
        realBal += win;
        const newTotal = realBal + bonusBal;

        await client.query(
            `UPDATE users 
             SET real_balance = $1, 
                 bonus_balance = $2,
                 balance = $3,
                 total_won = total_won + $4 
             WHERE id = $5`,
            [realBal, bonusBal, newTotal, win, user.id]
        );

        await client.query(
            `INSERT INTO transactions (user_id, type, payment_method, amount, sms_text, status) 
             VALUES ($1, 'KENO_BET', 'INTERNAL', $2, $3, 'APPROVED')`,
            [user.id, bet, `Keno Round #${roundId || 'LIVE'} | Picks: ${JSON.stringify(picks || [])} | Win: ${win}`]
        );

        await client.query('COMMIT');

        res.json({
            success: true,
            newBalance: parseFloat(newTotal.toFixed(2)),
            realBalance: parseFloat(realBal.toFixed(2)),
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
app.post('/api/user/sync', async (req, res) => {
    const { telegramId, firstName, username, ref } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'telegramId is required' });

    let referrerId = null;
    if (ref) {
        const parsed = parseInt(String(ref).replace('ref_', ''));
        if (!isNaN(parsed) && parsed !== parseInt(telegramId)) {
            referrerId = parsed;
        }
    }

    try {
        const { rows } = await pool.query(
            `INSERT INTO users (telegram_id, first_name, username, referred_by) 
             VALUES ($1, $2, $3, $4) 
             ON CONFLICT (telegram_id) DO UPDATE 
             SET first_name = EXCLUDED.first_name, username = EXCLUDED.username 
             RETURNING id, telegram_id, first_name, username, real_balance, bonus_balance, 
                       (real_balance + bonus_balance) as balance, total_deposited, total_won`,
            [telegramId, firstName || 'ተጫዋች', username || '', referrerId]
        );
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/user/:telegramId', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT *, (real_balance + bonus_balance) as balance 
             FROM users WHERE telegram_id = $1`, 
            [req.params.telegramId]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 🚫 የውሸት ቦነስ እንዳይሰጥ Welcome Bonus ተዘግቷል
app.post('/api/user/claim-welcome', async (req, res) => {
    res.status(400).json({ error: 'የነፃ ቦነስ አገልግሎት ለጊዜው ተዘግቷል!' });
});

// ================= ⚡ VERIFI V5 AUTOMATED TELEBIRR DEPOSIT ================= //
app.post('/api/deposit/telebirr-verify', async (req, res) => {
    const { telegramId, rawInput, typedAmount } = req.body;

    if (!telegramId || !rawInput) {
        return res.status(400).json({ error: 'እባክዎ የግብይት ቁጥር (Ref) ወይም ሙሉ የቴሌብር SMS ያስገቡ!' });
    }

    const parsed = parseTelebirrInput(rawInput);
    const ref = parsed.ref;
    const finalAmount = parsed.amount || parseFloat(typedAmount);

    if (!ref || ref.length < 8) {
        return res.status(400).json({ error: 'ትክክለኛ የቴሌብር ግብይት ቁጥር (Ref ለምሳሌ DJC5Q7Q5UV) አልተገኘም!' });
    }

    if (!finalAmount || finalAmount < MINIMUM_DEPOSIT) {
        return res.status(400).json({ error: `ዝቅተኛው የዴፖዚት መጠን ${MINIMUM_DEPOSIT} ETB ነው!` });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const userRes = await client.query('SELECT id, telegram_id, real_balance, bonus_balance FROM users WHERE telegram_id = $1 FOR UPDATE', [telegramId]);
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

        const orderId = `DEP_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const verifyUrl = `${TELEBIRR_API_URL}?token=${encodeURIComponent(TELEBIRR_SECRET_TOKEN)}&ref=${encodeURIComponent(ref)}&amount=${encodeURIComponent(finalAmount)}`;
        
        let gatewayResponse;
        try {
            const resp = await fetch(verifyUrl, {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            });
            gatewayResponse = await resp.json();
        } catch (fetchErr) {
            await client.query('ROLLBACK');
            console.error('Verifi Fetch Error:', fetchErr);
            return res.status(502).json({ error: 'የቴሌብር ማረጋገጫ ሲስተሙ ለጊዜው አልመለሰም፤ እባክዎ ጥቂት ሰከንዶች ጠብቀው እንደገና ይሞክሩ።' });
        }

        const gStatus = gatewayResponse?.status;

        if (gStatus === 'Pending') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ክፍያው ገና አልደረሰም፤ እባክዎ ጥቂት ሰከንዶች ጠብቀው እንደገና ይሞክሩ።' });
        }

        if (gStatus === 'AlreadyUsed') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ይህ የግብይት ቁጥር ቀደም ሲል ጥቅም ላይ ውሏል!' });
        }

        if (gStatus === 'InvalidAmount') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'የተላከው የገንዘብ መጠን ከተጠየቀው መጠን ጋር አይዛመድም።' });
        }

        if (gStatus === 'Invalid_Transaction_Type') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'ይህ የገንዘብ መቀበያ ሳይሆን የወጪ ማስተላለፊያ ደረሰኝ ነው፤ ውድቅ ተደርጓል።' });
        }

        const isVerified = (gStatus === 'Verified' || gStatus === 'success' || gatewayResponse?.verified === true);
        if (!isVerified) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: gatewayResponse?.message || 'ክፍያውን ማረጋገጥ አልተቻለም።' });
        }

        const verifiedAmount = parseFloat(gatewayResponse.amount || finalAmount);
        const newRealBalance = parseFloat(user.real_balance || 0) + verifiedAmount;
        const newTotalBalance = newRealBalance + parseFloat(user.bonus_balance || 0);

        // 💵 ወደ REAL BALANCE ብቻ መጨመር
        await client.query(
            `UPDATE users 
             SET real_balance = $1, 
                 balance = $2,
                 total_deposited = total_deposited + $3 
             WHERE id = $4`,
            [newRealBalance, newTotalBalance, verifiedAmount, user.id]
        );

        await client.query(
            `INSERT INTO transactions (user_id, type, payment_method, amount, trx_ref, order_id, status) 
             VALUES ($1, 'DEPOSIT', 'TELEBIRR', $2, $3, $4, 'APPROVED')`,
            [user.id, verifiedAmount, ref, orderId]
        );

        await client.query('COMMIT');

        sendTelegramNotification(
            telegramId,
            `✅ <b>የቴሌብር ዴፖዚትዎ በራስ-ሰር ጸድቋል!</b>\n\nመጠን፡ <b>${verifiedAmount.toFixed(2)} ETB</b>\nRef: <code>${ref}</code>\nየ Real Wallet ሒሳብዎ፡ <b>${newRealBalance.toFixed(2)} ETB</b>\n\nአሁኑኑ ገብተው ይጫወቱ!`
        );

        res.json({
            success: true,
            amount: verifiedAmount,
            ref,
            newRealBalance,
            message: `🎉 እንኳን ደስ አለዎት! ${verifiedAmount.toFixed(2)} ETB በራስ-ሰር ተረጋግጦ ወደ Real Walletዎ ገቢ ሆኗል!`
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Telebirr Verify Error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// ================= WITHDRAWAL API (ቦነስን በፍጹም የማያወጣ - ZERO LEAK) ================= //
app.post('/api/withdraw', async (req, res) => {
    const { telegramId, amount, accountNumber, accountName } = req.body;
    const withdrawAmount = parseFloat(amount);

    if (isNaN(withdrawAmount) || withdrawAmount < 100) {
        return res.status(400).json({ error: 'አነስተኛው የማውጣት መጠን 100 ETB ነው!' });
    }
    if (withdrawAmount > 5000) {
        return res.status(400).json({ error: 'በአንድ ጊዜ የሚፈቀደው ከፍተኛው የማውጣት መጠን 5,000 ETB ነው!' });
    }
    if (!accountNumber || !accountName) {
        return res.status(400).json({ error: 'እባክዎ የቴሌብር ስልክ እና ሙሉ ስም በትክክል ያስገቡ!' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userRes = await client.query(
            `SELECT id, real_balance, bonus_balance, total_deposited FROM users WHERE telegram_id = $1 FOR UPDATE`, 
            [telegramId]
        );
        if (userRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'ተጠቃሚው አልተገኘም' });
        }

        const user = userRes.rows[0];

        // 🛡️ 1. ቢያንስ 1 ጊዜ 50 ETB ዴፖዚት ማድረግ ግዴታ ነው
        if (parseFloat(user.total_deposited || 0) < MINIMUM_DEPOSIT) {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                error: `ገንዘብ ለማውጣት ቢያንስ 1 ጊዜ ${MINIMUM_DEPOSIT} ETB ተቀማጭ ማድረግ ግዴታ ነው!` 
            });
        }

        // 🛡️ 2. የሚወጣው ከ REAL BALANCE ብቻ ነው! ቦነስ በፍጹም አይነካም!
        const availableReal = parseFloat(user.real_balance || 0);
        if (availableReal < withdrawAmount) {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                error: `በቂ Real Balance የለዎትም! ማውጣት የሚቻለው ከ Real Wallet ብቻ ነው። (ያለዎት Real ሒሳብ: ${availableReal.toFixed(2)} ETB)` 
            });
        }

        // በቀን ቢበዛ 2 ጊዜ ማውጣት
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

        const fee = withdrawAmount * 0.05;
        const netPayout = withdrawAmount - fee;

        const newReal = availableReal - withdrawAmount;
        const newTotal = newReal + parseFloat(user.bonus_balance || 0);

        // ከ Real Balance ብቻ ይቀንሳል
        await client.query(
            `UPDATE users 
             SET real_balance = $1, 
                 balance = $2 
             WHERE id = $3`, 
            [newReal, newTotal, user.id]
        );

        await client.query(
            `INSERT INTO transactions (user_id, type, payment_method, amount, account_number, account_name, status) 
             VALUES ($1, 'WITHDRAW', 'TELEBIRR', $2, $3, $4, 'PENDING')`,
            [user.id, netPayout, accountNumber, accountName]
        );

        await client.query('COMMIT');

        sendTelegramNotification(
            telegramId,
            `📤 <b>የማውጣት ጥያቄ ደርሶናል</b>\n\nየተጠየቀው መጠን፡ <b>${withdrawAmount.toFixed(2)} ETB</b>\nየአገልግሎት ክፍያ (5%)፡ <b>${fee.toFixed(2)} ETB</b>\nየሚደርስዎት የተጣራ ብር፡ <b>${netPayout.toFixed(2)} ETB</b>\nወደ ቴሌብር፡ <b>${accountNumber}</b> (${accountName})\n\nኤጀንቱን ያነጋግሩ፡ @Dashagent1`
        );

        res.json({ 
            success: true, 
            message: `የ ${withdrawAmount} ETB ማውጣት ጥያቄዎ ተመዝግቧል!` 
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// 🚫 Promo Code Redeem ለጊዜው ተዘግቷል
app.post('/api/promocode/redeem', async (req, res) => {
    res.status(400).json({ error: 'የፕሮሞ ኮድ አገልግሎት ለጊዜው ተዘግቷል!' });
});

// Leaderboard & History
app.get('/api/weekly-top', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT first_name, username, cards_bought_this_week 
             FROM users 
             WHERE cards_bought_this_week > 0 
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

app.get('/api/history/:telegramId', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT t.* FROM transactions t 
             JOIN users u ON u.id = t.user_id 
             WHERE u.telegram_id = $1 ORDER BY t.created_at DESC LIMIT 50`,
            [req.params.telegramId]
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ================= 📊 ALL-TIME FINANCIAL AUDIT API ================= //
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
                COALESCE(SUM(CASE WHEN type = 'DEPOSIT' AND status = 'APPROVED' THEN amount ELSE 0 END), 0) AS telebirr_deposits,
                COALESCE(SUM(CASE WHEN type = 'WITHDRAW' AND status = 'APPROVED' THEN amount ELSE 0 END), 0) AS telebirr_withdrawals,
                COALESCE(SUM(CASE WHEN type = 'DEPOSIT' AND status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pending_deposits_count,
                COALESCE(SUM(CASE WHEN type = 'WITHDRAW' AND status = 'PENDING' THEN 1 ELSE 0 END), 0) AS pending_withdrawals_count
            FROM transactions
            WHERE 1=1 ${timeFilterTx};
        `;
        const { rows } = await pool.query(auditQuery);
        const data = rows[0];

        const userBalRes = await pool.query('SELECT COALESCE(SUM(real_balance), 0) AS total_liability, COUNT(*) AS total_users FROM users');
        const periodUsersRes = await pool.query(`SELECT COUNT(*) AS period_users FROM users ${timeFilterUsers}`);
        const roundRes = await pool.query(`SELECT COALESCE(SUM(owner_rake), 0) AS total_rake, COUNT(*) AS round_count FROM bingo_rounds ${timeFilterRounds}`);

        const totalDep = parseFloat(data.telebirr_deposits);
        const totalWith = parseFloat(data.telebirr_withdrawals);
        const netCash = totalDep - totalWith;

        res.json({
            timeframe,
            totalDeposits: totalDep,
            telebirrDeposits: totalDep,
            totalWithdrawals: totalWith,
            telebirrWithdrawals: totalWith,
            netCash,
            aymenShare: netCash * 0.50,
            nebyuShare: netCash * 0.50,
            pendingDepositsCount: parseInt(data.pending_deposits_count),
            pendingWithdrawalsCount: parseInt(data.pending_withdrawals_count),
            totalRealLiability: parseFloat(userBalRes.rows[0].total_liability),
            totalBonusLiability: 0.00,
            totalUsersAllTime: parseInt(userBalRes.rows[0].total_users),
            usersInPeriod: parseInt(periodUsersRes.rows[0].period_users),
            totalRake: parseFloat(roundRes.rows[0].total_rake),
            totalRounds: parseInt(roundRes.rows[0].round_count),
            agentStatus
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Transactions List API (Filtered & Limit 300)
app.get('/api/admin/transactions', checkAdminAuth, async (req, res) => {
    const { category, timeframe } = req.query;
    let conditions = ["t.type IN ('DEPOSIT', 'WITHDRAW', 'KENO_BET')"];

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

// ⚡ የውሸት/ያልተገባ የዊዝድሮው ጥያቄዎችን በጅምላ ማጽጃ (Bulk Reject Fake Withdrawals)
app.post('/api/admin/cancel-fake-withdrawals', checkAdminAuth, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // 50 ብር ዴፖዚት ሳያደርጉ የተጠየቁትን PENDING ዊዝድሮዎች በሙሉ ውድቅ ማድረግ
        const { rows } = await client.query(`
            SELECT t.id, t.amount, u.telegram_id, u.first_name 
            FROM transactions t
            JOIN users u ON u.id = t.user_id
            WHERE t.type = 'WITHDRAW' AND t.status = 'PENDING' AND u.total_deposited < 50
        `);

        for (const fakeTx of rows) {
            await client.query("UPDATE transactions SET status = 'REJECTED' WHERE id = $1", [fakeTx.id]);
            sendTelegramNotification(
                fakeTx.telegram_id,
                `❌ <b>የማውጣት ጥያቄዎ ውድቅ ተደርጓል</b>\n\nውድ ${fakeTx.first_name}፣ ገንዘብ ለማውጣት ቢያንስ 1 ጊዜ 50 ETB ተቀማጭ ማድረግ ግዴታ ነው።`
            );
        }

        await client.query('COMMIT');
        res.json({ success: true, message: `በድምሩ ${rows.length} ያላግባብ የተጠየቁ ዊዝድሮዎች ተሰርዘዋል!` });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
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
                     balance = real_balance + $1 + bonus_balance,
                     total_deposited = total_deposited + $1 
                 WHERE id = $2`, 
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
                `✅ <b>የማውጣት ጥያቄዎ ተፈጽሟል!</b>\n\nየ <b>${parseFloat(tx.amount).toFixed(2)} ETB</b> የተጣራ ክፍያ ወደ ቴሌብር <b>${tx.account_number}</b> ተልኮልዎታል። እናመሰግናለን!`
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

app.post('/api/admin/reject', checkAdminAuth, async (req, res) => {
    const { txId } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const txRes = await client.query(`SELECT t.*, u.telegram_id FROM transactions t JOIN users u ON u.id = t.user_id WHERE t.id = $1 FOR UPDATE`, [txId]);
        const tx = txRes.rows[0];

        if (tx.type === 'WITHDRAW') {
            await client.query(
                `UPDATE users 
                 SET real_balance = real_balance + $1,
                     balance = real_balance + $1 + bonus_balance 
                 WHERE id = $2`, 
                [tx.amount, tx.user_id]
            );
        }

        await client.query("UPDATE transactions SET status = 'REJECTED' WHERE id = $1", [txId]);
        await client.query('COMMIT');

        sendTelegramNotification(
            tx.telegram_id,
            `🔄 <b>ውድ የ Dash ተጫዋች፦</b>\n\nየጠየቁት የ <b>${parseFloat(tx.amount).toFixed(2)} ETB</b> ማውጣት ጥያቄ ወደ Real Walletዎ ተመልሷል! ✅\n\n@DashBingo`
        );

        res.json({ success: true, message: 'ግብይቱ ውድቅ ተደርጎ ገንዘቡ ወደ ተጫዋቹ ዋሌት ተመልሷል!' });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// Broadcast Message
app.post('/api/admin/broadcast', checkAdminAuth, async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    try {
        const { rows } = await pool.query('SELECT telegram_id FROM users');
        let sentCount = 0;
        for (const user of rows) {
            try {
                await bot.telegram.sendMessage(user.telegram_id, message, { parse_mode: 'HTML' });
                sentCount++;
                await new Promise(r => setTimeout(r, 45));
            } catch (err) {}
        }
        res.json({ success: true, message: `መልእክቱ ለ ${sentCount} ተጫዋቾች ተልኳል!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ================= SOCKET.IO: BUY BINGO CARD ================= //
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

    socket.on('buy_card', async ({ telegramId, cardIndex }) => {
        const cIndex = parseInt(cardIndex);
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
                `SELECT id, first_name, real_balance, bonus_balance 
                 FROM users WHERE telegram_id = $1 FOR UPDATE`, 
                [telegramId]
            );
            if (userRes.rows.length === 0) {
                await client.query('ROLLBACK');
                return;
            }
            const user = userRes.rows[0];

            let realBal = parseFloat(user.real_balance || 0);
            let bonusBal = parseFloat(user.bonus_balance || 0);

            // መጀመሪያ ከ Real Balance ይቀንሳል፤ ከሌለ ከ Bonus
            if (realBal >= CARD_PRICE) {
                realBal -= CARD_PRICE;
            } else if (bonusBal >= CARD_PRICE) {
                bonusBal -= CARD_PRICE;
            } else {
                await client.query('ROLLBACK');
                socket.emit('error_msg', `ሒሳብዎ በቂ አይደለም! ካርድ ለመቁረጥ ቢያንስ ${CARD_PRICE} ETB ያስፈልጋል።`);
                return;
            }

            await client.query(
                `UPDATE users 
                 SET real_balance = $1,
                     bonus_balance = $2,
                     balance = $1 + $2, 
                     cards_bought_this_week = cards_bought_this_week + 1 
                 WHERE id = $3`, 
                [realBal, bonusBal, user.id]
            );

            const generatedCard = generateBingoCard();
            gameState.selectedCards[cIndex] = {
                userId: user.id,
                userName: user.first_name,
                numbers: generatedCard
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
    console.log(`⚡ Dash Bingo Ultra-Server running securely on port ${PORT}`);
    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    } catch (e) {}
    bot.launch({ dropPendingUpdates: true })
        .then(() => console.log('🤖 Telegram Bot polling started successfully'))
        .catch(err => {
            console.warn('⚠️ Telegram Bot Launch Notice:', err.message);
        });
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
