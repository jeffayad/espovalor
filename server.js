
require("dotenv").config();

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3005;

function pick(obj, names) {
    for (const name of names) {
        if (obj && obj[name] !== undefined && obj[name] !== null && String(obj[name]).trim() !== "") {
            return String(obj[name]).trim();
        }
    }
    return "";
}

function centsToMoney(value) {
    if (value === undefined || value === null || value === "") return 0;
    const n = Number(String(value).replace(/[^0-9.-]/g, ""));
    if (Number.isNaN(n)) return 0;
    return n / 100;
}


function parseMoney(value) {
    if (value === undefined || value === null || value === "") return 0;
    const n = Number(String(value).replace(/[^0-9.-]/g, ""));
    if (Number.isNaN(n)) return 0;
    return n;
}

function parseValorDateTime(dateValue, timeValue) {
    const date = String(dateValue || "").trim();
    const time = String(timeValue || "").trim();
    const raw = `${date} ${time}`.trim();
    if (!raw) return 0;

    const direct = Date.parse(raw);
    if (!Number.isNaN(direct)) return direct;

    const compact = raw.match(/^(\d{4})(\d{2})(\d{2})(?:\s*(\d{2})(\d{2})(\d{2})?)?$/);
    if (compact) {
        const [, y, m, d, hh = "00", mm = "00", ss = "00"] = compact;
        return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}`).getTime();
    }

    const slash = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})(?:\s+(.*))?$/);
    if (slash) {
        let [, a, b, y, t = "00:00:00"] = slash;
        if (y.length === 2) y = `20${y}`;
        const normalized = `${y}-${a.padStart(2, "0")}-${b.padStart(2, "0")} ${t}`;
        const parsed = Date.parse(normalized);
        if (!Number.isNaN(parsed)) return parsed;
    }

    return 0;
}

function normalizeBatchNumber(value) {
    const v = String(value || "").trim();
    return v || "Unbatched";
}

function buildRecentBatches(transactions, limit = 3) {
    const grouped = new Map();

    for (const txn of transactions) {
        const batchNo = normalizeBatchNumber(txn.batchNo || txn.batchId);
        const key = `${txn.terminalEpi || ""}::${batchNo}`;
        if (!grouped.has(key)) {
            grouped.set(key, {
                batchNo,
                batchId: txn.batchId || "",
                terminalName: txn.terminalName || txn.terminalEpi || "Terminal",
                terminalEpi: txn.terminalEpi || "",
                transactionCount: 0,
                approvedCount: 0,
                declinedCount: 0,
                totalAmount: 0,
                latestTimestamp: 0,
                latestDate: "",
                latestTime: ""
            });
        }

        const batch = grouped.get(key);
        const amount = Number(txn.amount) || 0;
        const status = String(txn.status || "").toUpperCase();
        const ts = txn.timestamp || parseValorDateTime(txn.date, txn.time);

        batch.transactionCount += 1;
        batch.totalAmount += amount;
        if (status.includes("APPROV") || status === "00" || status.includes("SUCCESS")) batch.approvedCount += 1;
        if (status.includes("DECLIN") || status.includes("ERROR") || status.includes("FAIL")) batch.declinedCount += 1;
        if (ts >= batch.latestTimestamp) {
            batch.latestTimestamp = ts;
            batch.latestDate = txn.date || "";
            batch.latestTime = txn.time || "";
        }
    }

    return Array.from(grouped.values())
        .sort((a, b) => (b.latestTimestamp || 0) - (a.latestTimestamp || 0))
        .slice(0, limit);
}

function findTransactions(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;

    const keys = ["transactions", "transaction", "txn", "txns", "data", "records", "result", "response", "list", "TxnList", "TXN_LIST"];

    for (const key of keys) {
        if (Array.isArray(data[key])) return data[key];
        if (data[key] && typeof data[key] === "object") {
            const nested = findTransactions(data[key]);
            if (nested.length) return nested;
        }
    }

    for (const value of Object.values(data)) {
        if (Array.isArray(value)) return value;
        if (value && typeof value === "object") {
            const nested = findTransactions(value);
            if (nested.length) return nested;
        }
    }

    return [];
}

function espoBaseUrl() {
    if (!process.env.ESPO_URL || !process.env.ESPO_API_KEY) {
        throw new Error("Missing ESPO_URL or ESPO_API_KEY in .env");
    }

    return process.env.ESPO_URL.replace(/\/$/, "");
}

function espoHeaders() {
    return {
        "X-Api-Key": process.env.ESPO_API_KEY
    };
}

async function espoGet(path) {
    const url = `${espoBaseUrl()}${path}`;

    try {
        const response = await axios.get(url, {
            headers: espoHeaders(),
            timeout: 30000
        });

        return response.data;
    } catch (error) {
        const e = new Error(`Espo GET failed: ${path}`);
        e.debug = {
            url,
            status: error.response?.status,
            response: error.response?.data || error.message
        };
        throw e;
    }
}

async function getEspoAccount(accountId) {
    try {
        return await espoGet(`/api/v1/Account/${encodeURIComponent(accountId)}`);
    } catch (error) {
        const e = new Error("Espo Account lookup failed");
        e.debug = {
            step: "getEspoAccount",
            ...error.debug
        };
        throw e;
    }
}

async function getValorTerminals(accountId) {
    const entityName = process.env.VALOR_TERMINAL_ENTITY || "CValorTerminal";

    // Confirmed working in PowerShell/browser. Do not add ?maxSize.
    const data = await espoGet(`/api/v1/${encodeURIComponent(entityName)}`);

    let list = [];
    if (Array.isArray(data)) list = data;
    else if (Array.isArray(data.list)) list = data.list;
    else if (Array.isArray(data.records)) list = data.records;
    else if (Array.isArray(data.data)) list = data.data;

    const terminals = list.filter(record => {
        const recordAccountId = pick(record, ["accountId", "account"]);
        const isActive = record.active === true || record.active === "true" || record.active === 1 || record.active === "1";
        return recordAccountId === accountId && isActive;
    });

    return {
        terminals,
        entityNameUsed: entityName,
        countBeforeFilter: list.length,
        countAfterFilter: terminals.length
    };
}

async function callValorForTerminal({ account, terminal, startDate, endDate }) {
    const appid = pick(account, ["cAPPID", "cAppId", "cAppid", "cappid", "appId"]);
    const channelid = pick(account, ["cChannelID", "cChannelId", "cChannelid", "cchannelid", "channelId", "channelid"]);

    const appkey = pick(terminal, ["appkey", "appKey", "APPKEY"]);
    const epi = pick(terminal, ["epi", "EPI"]);

    if (!appid) throw new Error("Missing cAPPID on Account.");
    if (!appkey || !epi) throw new Error(`Missing appkey or epi on terminal ${terminal.name || terminal.id || ""}.`);

    const payload = {
        appid,
        appkey,
        epi,
        txn_type: "txnfetch_date",
        start_date_range: startDate,
        end_date_range: endDate,
        source: "0",
        transaction_type: "0",
        card_type: "0",
        transaction_status: "ALL",
        devices: "0",
        processor: "0",
        filter: "EPI",
        filter_text: epi,
        limit: "500",
        offset: "0",
        offline_mode: 0,
        version: 2
    };

    if (channelid) {
        payload.channelid = channelid;
        payload.channel_id = channelid;
    }

    const valorResponse = await axios.post(
        "https://securelink.valorpaytech.com:4430/?txnlist",
        payload,
        {
            headers: {
                "Content-Type": "application/json"
            },
            timeout: 60000
        }
    );

    const raw = valorResponse.data;
    const transactions = findTransactions(raw);
    const terminalName = terminal.name || terminal.label || epi;

    const normalized = transactions.map(txn => ({
        terminalName,
        terminalEpi: epi,
        date: pick(txn, ["DATE", "date", "txn_date", "created_at"]),
        time: pick(txn, ["TIME", "time", "txn_time"]),
        type: pick(txn, ["TXN_TYPE", "txn_type", "transaction_type", "type"]),
        status: pick(txn, ["TRANSACTION_STATUS", "transaction_status", "STATUS", "status", "RESPONSE_TEXT", "RESPONSE_CODE"]),
        cardType: pick(txn, ["CARD_TYPE", "card_type", "CARD_SCHEME", "card_scheme"]),
        pan: pick(txn, ["PAN", "pan", "masked_card", "card"]),
        authCode: pick(txn, ["AUTH_CODE", "APPROVAL_CODE", "auth_code", "approval_code"]),
        refTxnId: pick(txn, ["REF_TXN_ID", "ref_txn_id", "txn_id", "transaction_id"]),
        batchNo: pick(txn, ["BATCH_NO", "BATCHNO", "batch_no", "batchNo", "batch_number", "BATCH_NUMBER"]),
        batchId: pick(txn, ["BATCH_ID", "batch_id", "batchID", "BATCHID"]),
        amount: centsToMoney(pick(txn, ["NET_AMOUNT", "BASE_AMOUNT", "AMOUNT", "amount", "net_amount", "base_amount"])),
        timestamp: parseValorDateTime(pick(txn, ["DATE", "date", "txn_date", "created_at"]), pick(txn, ["TIME", "time", "txn_time"])),
        raw: txn
    }));

    return {
        terminal: {
            id: terminal.id,
            name: terminalName,
            epi
        },
        count: normalized.length,
        transactions: normalized,
        raw
    };
}

app.get("/api/debug-espo", async (req, res) => {
    try {
        const accountId = req.query.accountId;
        if (!accountId) return res.status(400).json({ success: false, message: "Missing accountId" });

        const account = await getEspoAccount(accountId);
        const terminalSearch = await getValorTerminals(accountId);

        res.json({
            success: true,
            espoUrl: espoBaseUrl(),
            account: {
                id: account.id,
                name: account.name,
                cAPPIDFound: !!pick(account, ["cAPPID", "cAppId", "cAppid", "cappid", "appId"]),
                cChannelIDFound: !!pick(account, ["cChannelID", "cChannelId", "cChannelid", "cchannelid", "channelId", "channelid"])
            },
            terminalSearch: {
                entityNameUsed: terminalSearch.entityNameUsed,
                countBeforeFilter: terminalSearch.countBeforeFilter,
                countAfterFilter: terminalSearch.countAfterFilter
            },
            matchedTerminals: terminalSearch.terminals.map(t => ({
                id: t.id,
                name: t.name,
                epi: t.epi,
                active: t.active,
                accountId: t.accountId
            }))
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error.message,
            debug: error.debug || error.message
        });
    }
});

app.get("/api/account-transactions", async (req, res) => {
    try {
        const { accountId } = req.query;

        if (!accountId) {
            return res.status(400).json({
                success: false,
                message: "Missing accountId. Example: /?accountId=ACCOUNT_ID_FROM_ESPO"
            });
        }

        const account = await getEspoAccount(accountId);
        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        const startDate = req.query.startDate || yesterday.toISOString().slice(0, 10);
        const endDate = req.query.endDate || now.toISOString().slice(0, 10);

        const terminalSearch = await getValorTerminals(accountId);
        const terminals = terminalSearch.terminals;

        if (!terminals.length) {
            return res.status(400).json({
                success: false,
                message: "No active Valor Terminal records found for this Account.",
                terminalSearch: {
                    entityNameUsed: terminalSearch.entityNameUsed,
                    countBeforeFilter: terminalSearch.countBeforeFilter,
                    countAfterFilter: terminalSearch.countAfterFilter
                },
                account: {
                    id: account.id,
                    name: account.name || ""
                }
            });
        }

        const results = [];
        for (const terminal of terminals) {
            try {
                const result = await callValorForTerminal({
                    account,
                    terminal,
                    startDate,
                    endDate
                });
                results.push(result);
            } catch (error) {
                results.push({
                    terminal: {
                        id: terminal.id,
                        name: terminal.name || terminal.epi || "Unknown Terminal",
                        epi: terminal.epi || ""
                    },
                    count: 0,
                    transactions: [],
                    error: error.response?.data || error.message
                });
            }
        }

        const allTransactions = results.flatMap(result => result.transactions || []);

        allTransactions.sort((a, b) => {
            const bt = b.timestamp || parseValorDateTime(b.date, b.time);
            const at = a.timestamp || parseValorDateTime(a.date, a.time);
            if (bt !== at) return bt - at;
            return String(b.refTxnId || "").localeCompare(String(a.refTxnId || ""));
        });

        const recentBatches = buildRecentBatches(allTransactions, 3);

        res.json({
            success: true,
            account: {
                id: account.id,
                name: account.name || account.accountName || ""
            },
            entityNameUsed: terminalSearch.entityNameUsed,
            startDate,
            endDate,
            terminals: results.map(result => ({
                ...result.terminal,
                count: result.count,
                error: result.error || null
            })),
            count: allTransactions.length,
            total: allTransactions.reduce((sum, row) => sum + (Number(row.amount) || 0), 0),
            recentBatches,
            transactions: allTransactions,
            rawByTerminal: results
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Request failed",
            debug: error.debug || null,
            error: error.response?.data || error.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`Valor/Espo no-maxsize viewer running on port ${PORT}`);
});
