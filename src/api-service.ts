/* eslint-disable no-constant-condition */
/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { WebAPICallResult, WebClient } from '@slack/web-api';
import chalk from 'chalk';
import Conf from 'conf/dist/source';
import { add, format, formatISO, parseISO } from 'date-fns';
import fs, { promises as fsPromises } from 'fs';
import path from 'path';
import sanitize from 'sanitize-filename';
import { Conversation, SlackMessage, SimpleMsg, User, SlackFile } from './model';
import axios, { AxiosInstance } from 'axios';


const timeout = (ms: number) => new Promise((res) => setTimeout(res, ms));


const REQUIRED_SCOPES = [
    'channels:history',
    'channels:read',
    'groups:history',
    'groups:read',
    'im:history',
    'im:read',
    'mpim:history',
    'mpim:read',
    'files:read',
    'users:read'];

async function delay(ms: number) {
    await timeout(ms);
}

export class APIService {
    private web: WebClient;

    private readonly axios: AxiosInstance;
    private team = '';
    private user = '';
    private userMap: { [key: string]: User } = {};
    private users: User[] = [];
    private conversations: Conversation[] = [];
    private startDate: Date | null = null;
    private endDate: Date | null = null;

    constructor(private state: Conf, _authToken: string, private exportRoot: string,
        startDateISO: string | undefined, endDateISO: string | undefined,
        private exportJson: boolean, private exportFiles: boolean) {
        this.web = new WebClient(_authToken);
        if (startDateISO) {
            this.startDate = parseISO(startDateISO);
        }
        if (endDateISO) {
            this.endDate = parseISO(endDateISO);
        }
        this.axios = axios.create({
            headers: {
                'Authorization': 'Bearer ' + _authToken
            }
        });
    }

    public async export(): Promise<void> {
        try {
            await fsPromises.access(this.exportRoot);
        } catch (x) {
            throw new Error(`EXPORT_TARGET_FOLDER value ${this.exportRoot} does not exist or is inaccessible: ${x}`);
        }
        const r = await this.web.auth.test();
        if (!r.ok) {
            return;
        }
        this.team = r.team as string;
        this.user = r.user as string;
        console.log(`Operating on team "${this.team}" and user "${this.user}"`);
        console.log(`Writing output to ${this.exportRoot}`);
        const scopes = r.response_metadata?.scopes as string[];
        if (!scopes) {
            throw new Error('Empty scopes?');
        }
        for (const scope of REQUIRED_SCOPES) {
            if (scopes.indexOf(scope) < 0) {
                throw new Error(`Missing required scope ${scope}`);
            }
        }
        console.log(chalk.greenBright('    Confirmed all necessary scopes present'));
        await this.loadUsers();
        await this.loadConversations();
        for (const conv of this.conversations) {
            await this.writeNewMsgs(conv, this.startDate, this.endDate);
        }
    }

    private async downloadFile(conv: Conversation, file: SlackFile): Promise<void> {
        const convTargetFolder = path.join(this.exportRoot, sanitize(conv.name as string));
        try {
            await fsPromises.access(convTargetFolder);
        } catch (x) {
            await fsPromises.mkdir(convTargetFolder);

        }
        if (!file.name) {
            // likely a tombstone deleted file
            console.log(chalk.red(`           Skipping file ${JSON.stringify(file)}`));            
            return;
        }
        const target = path.join(convTargetFolder, `${file.id}-${file.name}`);
        console.log(chalk.blue(`           Downloading ${target}`));
        const resp = await this.axios.get(file.url_private, { responseType: 'arraybuffer' });
        await fsPromises.writeFile(target, resp.data);
        console.log(chalk.blue(`           Downloaded ${target}`));
    }

    private async loadUsers(): Promise<void> {
        const r = await this.web.users.list();
        this.users = r.members as User[];
        this.userMap = {};
        for (const u of this.users) {
            this.userMap[u.id] = u;
        }
        const json = JSON.stringify(this.userMap);
        const target = path.join(this.exportRoot, 'Users.json');
        fsPromises.writeFile(target, json);
    }

    private async loadConversations(): Promise<void> {
        
        const paginate = await this.web.paginate('conversations.list', {types : 'public_channel, private_channel, mpim, im', limit : '600'} );
        //console.log(chalk.greenBright(` list ${paginate}`));
        for await (const page of paginate) {
            //console.log(page);
            //console.log(page.channels as Array<any>);
            const p_channels = page.channels as Conversation[];
            this.conversations = this.conversations.concat( p_channels );
            // for (const c of this.conversations) {
            //     console.log(c);
            // }
        }
        console.log(chalk.greenBright(` channels ${this.conversations.length}`));
        // const r = await this.web.conversations.list(
        //     //{ types: 'public_channel, private_channel, mpim, im' }
        // );
        //console.log(chalk.greenBright(` conversations ${r}`));
        //this.conversations = r.channels as Conversation[];
        for (const c of this.conversations) {
            if (c.is_im) {
                const user = this.users.find(x => c.user == x.id);
                c.name = user?.name;
                c.is_private = true;
                c.type = 'd-msg';
            } else if (c.is_mpim) {
                c.type = 'g-msg';
            } else {
                if (c.is_private) {
                    c.type = 'pr-ch';
                }
                c.type = 'pu-ch';
            }
        }
    }

    private static dateToSlackTs(date: Date): string {
        const ms = date.getTime();
        const seconds = ms / 1000;
        return seconds.toFixed(6);
    }

    private buildSimpleMsg(msg: SlackMessage): SimpleMsg {
        const ms = Math.floor(parseFloat(msg.ts) * 1000);
        const date = new Date(ms);
        //   const formatted = format(date, 'yyyy-MM-dd HH:mm:ss');    
        const name = this.userMap[msg.user] ? this.userMap[msg.user].name : 'unknown';
        return {
            name: name,
            ts: date,
            text: msg.text
        };
    }

    private async writeNewMsgs(conv: Conversation, startDate: Date | null, endDate: Date | null) {
        const lastIsoDate: string | undefined = this.state.get(conv.id) as string;
        let oldestDate: Date | null = null;
        if (lastIsoDate) {
            oldestDate = parseISO(lastIsoDate);
            console.log(chalk.grey(`   ${conv.name} Using previously last saved date ${APIService.printDate(oldestDate)}`));
        } else if (endDate) {
            oldestDate = startDate;
        }
        const finishDate = await this.writeMessages(conv, oldestDate, endDate);
        if (finishDate) {
            this.state.set(conv.id, formatISO(finishDate));
        }
    }

    private static printDate(date: Date | null): string {
        if (!date) {
            return 'null';
        }
        return format(date, 'yyyy-MM-dd HH:mm:ss');
    }

    private async writeMessages(conv: Conversation, oldestDate: Date | null, newestDate: Date | null): Promise<Date | null> {
        let cursor = undefined;
        const msgs: SimpleMsg[] = [];
        const jsonMsgs = [];
        let lastDate = oldestDate;
        let extraPages = false;
        while (true) {
            if (extraPages) {
                process.stdout.write('-');
            }
            const data: WebAPICallResult = await this.web.conversations.history({
                channel: conv?.id as string,
                latest: newestDate ? APIService.dateToSlackTs(newestDate) : undefined,
                oldest: oldestDate ? APIService.dateToSlackTs(oldestDate) : undefined,
                cursor: cursor,
                limit: 1000
            });
            const slackMsgs = data.messages as SlackMessage[];
            for (const s of slackMsgs) {
                const simpleMsg = this.buildSimpleMsg(s);
                msgs.push(simpleMsg);
                if (this.exportJson) {
                    jsonMsgs.push(s);
                }
                if (this.exportFiles) {
                    if (s.files && s.files.length > 0) {
                        for (const f of s.files!) {
                            await this.downloadFile(conv, f);
                        }
                    }
                }
            }
            if (!data.has_more) {
                break;
            }
            if (!extraPages) {
                process.stdout.write('    ');
                extraPages = true;
            }
            
            cursor = data.response_metadata?.next_cursor;
        }
        if (extraPages) {
            process.stdout.write('\r\n');
        }
        msgs.sort((a, b) => {
            if (a.ts < b.ts) {
                return -1;
            }
            if (a.ts > b.ts) {
                return 1;
            }
            return 0;
        });
        if (msgs.length > 0) {
            await this.writeMsgs(this.exportRoot, conv, msgs);
            lastDate = add(msgs[msgs.length - 1].ts, { seconds: 1 });
            if (this.exportJson) {
                const target = path.join(this.exportRoot, `${conv.type}-${sanitize(conv.name as string)}_${format(new Date(), 'yyyy-MM-dd-HHmmss')}.json`);
                await fsPromises.writeFile(target, JSON.stringify(jsonMsgs));
            }
        } else {
            // no messages found
        }
        console.log(chalk.yellow(`    Conv ${conv.name}: ${msgs.length}`));
        return lastDate;
    }

    private async writeMsgs(root: string, conv: Conversation, msgs: SimpleMsg[]) {
        const lines: string[] = [];
        if (conv.name == undefined) {
            conv.name = '_undefined_name';
        }
        const target = path.join(root, `${conv.type}-${sanitize(conv.name as string)}_${format(new Date(), 'yyyy-MM-dd-HHmmss')}.txt`);

        for (const m of msgs) {
            const formatted = format(m.ts, 'yyyy-MM-dd HH:mm:ss');
            const line = `${formatted} ${m.name}: ${m.text}`;
            lines.push(line);
        }
        await fsPromises.writeFile(target, lines.join('\r\n'));
    }

}
