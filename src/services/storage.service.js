const fs = require('fs').promises;
const path = require('path');
const Logger = require('../utils/logger');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

class StorageService {
    constructor(dbFilename = 'processed_ids.sqlite') {
        this.logger = new Logger('StorageService');
        this.dbPath = path.join(process.cwd(), dbFilename);
        this.oldJsonPath = path.join(process.cwd(), 'processed_ids.json');
        this.db = null;
    }

    async init() {
        try {
            this.db = await open({
                filename: this.dbPath,
                driver: sqlite3.Database
            });
            await this.db.exec(`
                CREATE TABLE IF NOT EXISTS processed_ids (
                    id TEXT PRIMARY KEY,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS app_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT
                );
            `);
            await this.migrateLegacyData();
            const row = await this.db.get('SELECT COUNT(*) as count FROM processed_ids');
            this.logger.info(`已載入 SQLite 資料庫，目前有 ${row.count} 筆歷史紀錄`);
        } catch (error) {
            this.logger.error('初始化 SQLite 資料庫失敗', error);
            throw error;
        }
    }

    async migrateLegacyData() {
        try {
            await fs.access(this.oldJsonPath);
            const content = await fs.readFile(this.oldJsonPath, 'utf8');
            const parsed = JSON.parse(content);
            if (Array.isArray(parsed) && parsed.length > 0) {
                this.logger.info(`找到舊版 JSON 紀錄檔，正在將 ${parsed.length} 筆資料遷移到 SQLite...`);
                await this.db.exec('BEGIN TRANSACTION');
                const stmt = await this.db.prepare('INSERT OR IGNORE INTO processed_ids (id) VALUES (?)');
                for (const id of parsed) {
                    await stmt.run(id);
                }
                await stmt.finalize();
                await this.db.exec('COMMIT');
                await fs.rename(this.oldJsonPath, this.oldJsonPath + '.bak');
                this.logger.info('資料遷移完成，舊檔案已更名為 processed_ids.json.bak');
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                this.logger.error('嘗試遷移舊版 JSON 資料時發生錯誤', error);
            }
        }
    }

    async has(id) {
        try {
            const row = await this.db.get('SELECT id FROM processed_ids WHERE id = ?', [id]);
            return !!row;
        } catch (err) {
            this.logger.error('查詢紀錄失敗', err);
            return false;
        }
    }

    async add(id) {
        try {
            await this.db.run('INSERT OR IGNORE INTO processed_ids (id) VALUES (?)', [id]);
        } catch (err) {
            this.logger.error('新增紀錄失敗', err);
        }
    }

    async getSetting(key) {
        try {
            const row = await this.db.get('SELECT value FROM app_settings WHERE key = ?', [key]);
            if (!row || !row.value) return null;
            return this._decryptSession(row.value);
        } catch (err) {
            this.logger.error(`讀取設定失敗 (${key})`, err);
            return null;
        }
    }

    async setSetting(key, value) {
        try {
            const encryptedStr = this._decryptSession(value, true);
            await this.db.run(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=?`,
                [key, encryptedStr, encryptedStr]);
        } catch (err) {
            this.logger.error(`寫入設定失敗 (${key})`);
        }
    }

    async deleteSetting(key) {
        try {
            await this.db.run(`DELETE FROM app_settings WHERE key = ?`, [key]);
        } catch (err) {
            this.logger.error(`刪除設定失敗 (${key})`, err);
        }
    }

    _decryptSession(text, isEncrypt = false) {
        const crypto = require('crypto');
        const tokenStr = process.env.DISCORD_TOKEN || 'fallback_secret_key_if_no_discord_token_provided';
        const key = crypto.createHash('sha256').update(tokenStr).digest();
        const algorithm = 'aes-256-cbc';

        if (isEncrypt) {
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv(algorithm, key, iv);
            let encrypted = cipher.update(text, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            return iv.toString('hex') + ':' + encrypted;
        } else {
            const parts = text.split(':');
            const iv = Buffer.from(parts.shift(), 'hex');
            const encryptedText = parts.join(':');
            const decipher = crypto.createDecipheriv(algorithm, key, iv);
            let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        }
    }
}

module.exports = StorageService;