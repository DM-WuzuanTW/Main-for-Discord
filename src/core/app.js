const configLoader = require('../config/config.loader');
const authService = require('../services/auth.service');
const StorageService = require('../services/storage.service');
const GmailService = require('../services/gmail.service');
const DiscordService = require('../services/discord.service');
const Logger = require('../utils/logger');

class GmailNotifierApp {
    constructor() {
        this.logger = new Logger('App');
        this.isRunning = false;
    }

    async bootstrap() {
        try {
            this.logger.info('正在啟動應用程式...');
            const config = await configLoader.load();
            this.config = config;
            this.storage = new StorageService();
            await this.storage.init();
            this.discordService = new DiscordService(config.discord);
            await this.discordService.init();

            const authClient = await authService.getClient(this.discordService, config.discord.targetUserId, this.storage);
            this.gmailService = new GmailService(authClient);
            this.discordService.onMarkAsRead = async (id) => {
                await this.gmailService.markAsRead(id);
                this.logger.info(`使用者透過 Discord 標記已讀: ${id}`);
            };
            this.logger.info('所有服務初始化完成');
            this.startPolling();
        } catch (error) {
            this.logger.error('應用程式啟動失敗', error);
            process.exit(1);
        }
    }

    startPolling() {
        this.isRunning = true;
        const intervalMinutes = this.config.gmail.pollingIntervalMinutes || 1;
        this.discordService.updatePresence(`信箱 (${intervalMinutes}m/次)`, 'online');
        this.logger.info(`開始監測任務，頻率: 每 ${intervalMinutes} 分鐘`);
        this.runTask();
        setInterval(() => this.runTask(), intervalMinutes * 60 * 1000);
    }

    async runTask() {
        try {
            const messages = await this.gmailService.getUnreadMessages();
            if (messages.length === 0) {
                return;
            }
            const newMessages = [];
            for (const msg of messages) {
                const hasBeenProcessed = await this.storage.has(msg.id);
                if (!hasBeenProcessed) {
                    newMessages.push(msg);
                }
            }
            if (newMessages.length === 0) {
                return;
            }
            this.logger.info(`發現 ${newMessages.length} 封新未讀郵件`);
            for (const msg of newMessages) {
                const details = await this.gmailService.getMessageDetails(msg.id);
                try {
                    await this.discordService.sendDM(this.config.discord.targetUserId, details);
                    await this.storage.add(msg.id);
                    await new Promise(r => setTimeout(r, 1000));
                } catch (sendError) {
                    this.logger.error(`發送通知失敗 (ID: ${msg.id})，將在 3 分鐘後重試...`);
                    setTimeout(async () => {
                        this.logger.info(`🔄 開始重試發送 (ID: ${msg.id})`);
                        try {
                            await this.discordService.sendDM(this.config.discord.targetUserId, details);
                            await this.storage.add(msg.id);
                            this.logger.info(`✅ 成功重發通知 (ID: ${msg.id})`);
                        } catch (err) {
                            this.logger.error(`❌ 重發通知依然失敗 (ID: ${msg.id})`, err);
                        }
                    }, 3 * 60 * 1000);
                }
            }
        } catch (error) {
            this.logger.error('執行監測任務時發生錯誤', error);

            const isInvalidGrant = error.response?.data?.error === 'invalid_grant' || String(error).includes('invalid_grant');
            if (isInvalidGrant) {
                this.logger.error('Token 已失效 (invalid_grant)！正在清除無效的授權記錄並中斷服務以重新授權。');

                try {
                    const user = await this.discordService.client.users.fetch(this.config.discord.targetUserId);
                    if (user) {
                        await user.send('⚠️ **[Gmail 監測服務警告]**\n您的 Google 授權 Token 已經失效 (通常是因為您的 Google Cloud 專案仍在「測試階段」，導致 Token 每 7 天過期一次)。\n\n**系統已自動清除無效的 Token 並停止目前的監測。**\n請**重新啟動機器人**，系統將會引導您重新進行認證綁定！\n\n💡 *解決「憑證很容易過期」的根本方法：請至 Google Cloud Console -> [API和服務] -> [OAuth 同意畫面] -> 點擊「發布應用程式 (Publish App)」，將發布狀態改為「實際運作 (In production)」。*');
                    }
                } catch (e) {
                    this.logger.error('無法傳送警告訊息給使用者', e);
                }

                if (this.storage) {
                    await this.storage.deleteSetting('user_tokens');
                }

                process.exit(1);
            }
        }
    }
}

module.exports = GmailNotifierApp;