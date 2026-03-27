const fs = require('fs').promises;
const path = require('path');
const url = require('url');
const { google } = require('googleapis');
const Logger = require('../utils/logger');

class AuthService {
    constructor() {
        this.logger = new Logger('AuthService');
        this.SCOPES = [
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/gmail.modify'
        ];
        this.TOKEN_PATH = path.join(process.cwd(), 'token.json');
        this.CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');
        this.client = null;
        this.storage = null;
    }

    async getClient(discordService, targetUserId, storage) {
        if (this.client) return this.client;
        this.storage = storage;

        const credentialsObj = await this._getClientCredentials(discordService, targetUserId);
        if (!credentialsObj) {
            this.logger.error('無法取得 Google 用戶端憑證。');
            process.exit(1);
        }

        this.client = await this._loadSavedTokensIfExist();

        if (this.client) {
            const key = credentialsObj.installed || credentialsObj.web;
            const redirectUri = key.redirect_uris && key.redirect_uris[0] !== 'urn:ietf:wg:oauth:2.0:oob' ? key.redirect_uris[0] : 'http://127.0.0.1';
            const oAuth2Client = new google.auth.OAuth2(
                key.client_id,
                key.client_secret,
                redirectUri
            );

            oAuth2Client.setCredentials(this.client.credentials);
            this.client = oAuth2Client;
            return this.client;
        }

        this.logger.info('無有效 Token，啟動新認證流程...');
        this.client = await this._authenticate(discordService, targetUserId, credentialsObj);

        if (this.client.credentials) {
            await this._saveTokens(this.client.credentials);
        }
        return this.client;
    }

    async _getClientCredentials(discordService, targetUserId) {
        let dbCreds = await this.storage.getSetting('client_credentials');
        if (dbCreds) {
            try { return JSON.parse(dbCreds); } catch (e) { }
        }

        let fileCreds;
        try {
            const content = await fs.readFile(this.CREDENTIALS_PATH);
            fileCreds = JSON.parse(content);
            await this.storage.setSetting('client_credentials', JSON.stringify(fileCreds));
            await fs.unlink(this.CREDENTIALS_PATH).catch(() => { });
            return fileCreds;
        } catch (e) { }

        await discordService.sendUploadCredentialsMessage(targetUserId);

        return new Promise((resolve) => {
            const listener = async (message) => {
                if (message.author.id !== targetUserId || !message.channel.isDMBased()) return;

                if (message.attachments.size > 0) {
                    const attachment = message.attachments.first();
                    if (attachment.name.endsWith('.json')) {
                        try {
                            const res = await fetch(attachment.url);
                            const jsonText = await res.text();
                            const parsed = JSON.parse(jsonText);

                            if (parsed.installed || parsed.web) {
                                await this.storage.setSetting('client_credentials', JSON.stringify(parsed));
                                await message.reply('✅ `credentials.json` 綁定成功並已安全加密儲存！正在確認使用者授權資訊...');
                                discordService.client.removeListener('messageCreate', listener);
                                resolve(parsed);
                            } else {
                                await message.reply('❌ 檔案格式似乎不正確，內容必須包含 `installed` 或 `web` 的 Google OAuth 客戶端資訊。');
                            }
                        } catch (err) {
                            await message.reply('❌ 無法解析檔案，請確認其為正確的 json 格式。');
                        }
                    }
                }
            };
            discordService.client.on('messageCreate', listener);
        });
    }

    async _loadSavedTokensIfExist() {
        let dbTokens = await this.storage.getSetting('user_tokens');
        if (dbTokens) {
            try {
                const creds = JSON.parse(dbTokens);
                return google.auth.fromJSON(creds);
            } catch (e) { }
        }

        try {
            const content = await fs.readFile(this.TOKEN_PATH);
            const credentials = JSON.parse(content);
            const authClient = google.auth.fromJSON(credentials);
            if (authClient) {
                await this.storage.setSetting('user_tokens', JSON.stringify(credentials));
                await fs.unlink(this.TOKEN_PATH).catch(() => { });
            }
            return authClient;
        } catch (err) {
            return null;
        }
    }

    async _authenticate(discordService, targetUserId, credentialsObj) {
        const key = credentialsObj.installed || credentialsObj.web;
        const redirectUri = key.redirect_uris && key.redirect_uris[0] !== 'urn:ietf:wg:oauth:2.0:oob' ? key.redirect_uris[0] : 'http://127.0.0.1';

        const oAuth2Client = new google.auth.OAuth2(
            key.client_id,
            key.client_secret,
            redirectUri
        );

        const authorizeUrl = oAuth2Client.generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent',
            scope: this.SCOPES,
        });

        await discordService.sendAuthMessage(targetUserId, authorizeUrl);
        this.logger.info('已將 Google 授權連結發送至您的 Discord 私訊中，請前往點擊。');

        return new Promise((resolve, reject) => {
            const listener = async (interaction) => {
                if (interaction.user.id !== targetUserId) return;

                if (interaction.isButton() && interaction.customId === 'auth_manual_input') {
                    const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

                    const modal = new ModalBuilder()
                        .setCustomId('auth_modal')
                        .setTitle('手動輸入授權碼');

                    const input = new TextInputBuilder()
                        .setCustomId('auth_code_input')
                        .setLabel("請貼上無法連線的網址 (或是 Code 本身)")
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder("http://127.0.0.1/?code=4/0Ae...")
                        .setRequired(true);

                    modal.addComponents(new ActionRowBuilder().addComponents(input));
                    await interaction.showModal(modal);
                }

                if (interaction.isModalSubmit() && interaction.customId === 'auth_modal') {
                    const text = interaction.fields.getTextInputValue('auth_code_input').trim();
                    let finalCode = null;
                    if (text.startsWith('http')) {
                        try {
                            const parsed = new url.URL(text);
                            finalCode = parsed.searchParams.get('code');
                        } catch (e) { }
                    } else if (text.length > 20) {
                        finalCode = text;
                    }

                    if (finalCode) {
                        await interaction.deferReply({ ephemeral: true });
                        try {
                            const { tokens } = await oAuth2Client.getToken(finalCode);
                            oAuth2Client.setCredentials(tokens);

                            await interaction.editReply('✅ **Google 帳號授權成功！** 系統已正式開始運作，會自動監控您的信箱。');

                            const message = interaction.message;
                            if (message && message.components) {
                                const newComponents = message.components.map(row => {
                                    const newRow = row.toJSON();
                                    newRow.components = newRow.components.map(comp => {
                                        comp.disabled = true;
                                        return comp;
                                    });
                                    return newRow;
                                });
                                await message.edit({ components: newComponents }).catch(() => { });
                            }

                            discordService.client.removeListener('interactionCreate', listener);
                            resolve(oAuth2Client);
                        } catch (err) {
                            await interaction.editReply('❌ **綁定失敗：** 授權碼無效或已過期，請重新索取。');
                        }
                    } else {
                        await interaction.reply({ content: '❌ 無法從您的輸入中解析出授權碼。', ephemeral: true });
                    }
                }
            };
            discordService.client.on('interactionCreate', listener);
        });
    }

    async _saveTokens(tokens) {
        const payload = JSON.stringify({
            type: 'authorized_user',
            client_id: this.client._clientId,
            client_secret: this.client._clientSecret,
            refresh_token: tokens.refresh_token,
        });
        await this.storage.setSetting('user_tokens', payload);
        this.logger.info('新 Token 已加密匯入儲存褲');
    }
}

module.exports = new AuthService();