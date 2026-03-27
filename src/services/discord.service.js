const { Client, GatewayIntentBits, Partials, Events } = require('discord.js');
const Logger = require('../utils/logger');
const Formatter = require('../utils/formatter');

class DiscordService {
    constructor(config) {
        this.config = config;
        this.logger = new Logger('DiscordBot');
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.DirectMessages
            ],
            partials: [Partials.Channel]
        });
        this.isReady = false;
        this.onMarkAsRead = null;
    }

    async init() {
        this.client.once(Events.ClientReady, () => {
            this.logger.info(`Bot 已登入: ${this.client.user.tag}`);
            this.isReady = true;
            this.updatePresence('等待授權與設定...', 'dnd');
        });

        this.client.on(Events.InteractionCreate, async interaction => {
            if (!interaction.isButton()) return;
            try {
                if (interaction.customId.startsWith('mark_read_')) {
                    const emailId = interaction.customId.replace('mark_read_', '');
                    await interaction.deferReply({ ephemeral: true });
                    if (this.onMarkAsRead) {
                        await this.onMarkAsRead(emailId);
                        const message = interaction.message;
                        const components = message.components;
                        if (components && components.length > 0) {
                            const newComponents = components.map(row => {
                                const newRow = row.toJSON();
                                newRow.components = newRow.components.map(comp => {
                                    if (comp.custom_id === interaction.customId) {
                                        comp.disabled = true;
                                        comp.label = '已標記為已讀';
                                    }
                                    return comp;
                                });
                                return newRow;
                            });
                            await message.edit({ components: newComponents });
                        }
                        await interaction.editReply({ content: '✅ 成功將郵件標記為已讀！您的 Gmail 也已經同步。' });
                        this.logger.info(`已處理來自 ${interaction.user.tag} 的標記已讀請求`);
                    } else {
                        await interaction.editReply({ content: '❌ 內部錯誤：未設定標記已讀處理函數。' });
                    }
                }
            } catch (error) {
                this.logger.error('處理按鈕互動時發生錯誤', error);
                if (interaction.deferred) {
                    await interaction.editReply({ content: '❌ 處理請求時發生錯誤。' }).catch(() => { });
                } else {
                    await interaction.reply({ content: '❌ 處理請求時發生錯誤。', ephemeral: true }).catch(() => { });
                }
            }
        });
        try {
            await this.client.login(this.config.token);
        } catch (error) {
            this.logger.error('登入失敗', error);
            throw error;
        }
    }

    async sendAuthMessage(userId, authUrl) {
        if (!this.isReady) {
            this.logger.warn('Bot 尚未就緒，無法發送訊息');
            return;
        }
        try {
            const user = await this.client.users.fetch(userId);
            if (!user) {
                this.logger.error(`找不到使用者 ID: ${userId}`);
                return;
            }
            const messageOptions = Formatter.createAuthMessage(authUrl);
            await user.send(messageOptions);
            this.logger.info(`已發送授權連結給 ${user.tag}`);
        } catch (error) {
            this.logger.error('發送授權連結失敗', error);
            throw error;
        }
    }

    async sendUploadCredentialsMessage(userId) {
        if (!this.isReady) {
            this.logger.warn('Bot 尚未就緒，無法發送訊息');
            return;
        }
        try {
            const user = await this.client.users.fetch(userId);
            if (!user) {
                this.logger.error(`找不到使用者 ID: ${userId}`);
                return;
            }
            const messageOptions = Formatter.createUploadCredentialsMessage();
            await user.send(messageOptions);
            this.logger.info(`已發送憑證索取通知給 ${user.tag}`);
        } catch (error) {
            this.logger.error('發送憑證索取通知失敗', error);
            throw error;
        }
    }

    async sendDM(userId, emailData) {
        if (!this.isReady) {
            this.logger.warn('Bot 尚未就緒，無法發送訊息');
            return;
        }
        try {
            const user = await this.client.users.fetch(userId);
            if (!user) {
                this.logger.error(`找不到使用者 ID: ${userId}`);
                return;
            }
            const messageOptions = Formatter.createEmailMessage(emailData);
            await user.send(messageOptions);
            this.logger.info(`已發送通知給 ${user.tag}`);
        } catch (error) {
            this.logger.error('發送私訊失敗', error);
            throw error;
        }
    }

    updatePresence(text, status = 'online') {
        if (!this.isReady) return;
        const { ActivityType } = require('discord.js');
        this.client.user.setPresence({
            activities: [{ name: text, type: ActivityType.Watching }],
            status: status,
        });
    }
}

module.exports = DiscordService;