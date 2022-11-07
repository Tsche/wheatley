import * as Discord from "discord.js";
import { strict as assert } from "assert";
import { critical_error, M } from "../utils";
import { MINUTE, TCCPP_ID } from "../common";
import { decode_snowflake, forge_snowflake } from "./snowflake";
import { BotComponent } from "../bot_component";
import { Wheatley } from "../wheatley";

// https://discord.com/channels/331718482485837825/802541516655951892/877257002584252426
//                              guild              channel            message
const quote_command_re = /^!(quoteb?)\s*https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)$/i;

const color = 0x7E78FE; //0xA931FF;

function is_image_link_embed(embed: Discord.Embed) {
    for(const key in embed) {
        if([ "type", "url", "thumbnail" ].indexOf(key) === -1) {
            const value = (embed as any)[key];
            if(!(value === null || (Array.isArray(value) && value.length == 0))) {
                return false;
            }
        }
    }
    return true;
}

function index_of_first_not_satisfying<T>(arr: T[], fn: (_: T) => boolean) {
    for(let i = 0; i < arr.length; i++) {
        if(!fn(arr[i])) {
            return i;
        }
    }
    return -1;
}

export class Quote extends BotComponent {
    constructor(wheatley: Wheatley) {
        super(wheatley);
    }

    override async on_message_create(message: Discord.Message) {
        if(message.author.id == this.wheatley.client.user!.id) return; // Ignore self
        if(message.author.bot) return; // Ignore bots
        //if(message.guildId != TCCPP_ID) return; // Ignore messages outside TCCPP (e.g. dm's)
        const match = message.content.match(quote_command_re);
        if(match != null) {
            M.log("Received quote command", message.content, message.url);
            assert(match.length == 5);
            const [ op, guild_id, channel_id, message_id ] = match.slice(1);
            if(guild_id == TCCPP_ID) {
                await this.do_quote(message, channel_id, message_id, op == "quoteb");
            }
        } else if(message.content.trim() == "!quote" || message.content.trim() == "!quoteb") {
            if(message.type == Discord.MessageType.Reply) {
                const reply = await message.fetchReference();
                await this.do_quote(message, reply.channel.id, reply.id, message.content.trim() == "!quoteb");
            } else {
                message.channel.send("`!quote <url>` or `!quote` while replying."
                                   + " !quoteb can be used to quote a continuous block of messages from a user");
            }
        }
    }

    // TODO: Redundant with server_suggestion_tracker
    async get_display_name(thing: Discord.Message | Discord.User): Promise<string> {
        if(thing instanceof Discord.User) {
            const user = thing;
            try {
                return (await this.wheatley.TCCPP.members.fetch(user.id)).displayName;
            } catch {
                // user could potentially not be in the server
                return user.tag;
            }
        } else if(thing instanceof Discord.Message) {
            const message = thing;
            if(message.member == null) {
                return this.get_display_name(message.author);
            } else {
                return message.member.displayName;
            }
        } else {
            assert(false);
        }
    }

    async make_quote(messages: Discord.Message[], requested_by: Discord.GuildMember) {
        assert(messages.length >= 1);
        const head = messages[0];
        const contents = messages.map(m => m.content).join("\n");
        const embed = new Discord.EmbedBuilder()
            .setColor(color)
            .setAuthor({
                name: `${await this.get_display_name(head)}`,
                iconURL: head.author.displayAvatarURL()
            })
            .setDescription(contents + `\n\nFrom <#${head.channel.id}> [[Jump to message]](${head.url})`)
            .setTimestamp(head.createdAt)
            .setFooter({
                text: `Quoted by ${requested_by.displayName}`,
                iconURL: requested_by.user.displayAvatarURL()
            });
        const images = messages.map(message => [
            ...message.attachments.filter(a => a.contentType?.indexOf("image") == 0).map(a => a.url),
            ...message.embeds.filter(is_image_link_embed).map(e => e.url!)
        ]).flat();
        const other_embeds = messages.map(message => message.embeds.filter(e => !is_image_link_embed(e))).flat();
        const image_embeds: Discord.EmbedBuilder[] = [];
        if(images.length > 0) {
            embed.setImage(images[0]);
            for(const image of images.slice(1)) {
                image_embeds.push(new Discord.EmbedBuilder({
                    image: {
                        url: image
                    }
                }));
            }
        }
        return [ embed, ...image_embeds, ...other_embeds ];
    }

    async do_quote(message: Discord.Message, channel_id: string, message_id: string, block: boolean) {
        const channel = await this.wheatley.TCCPP.channels.fetch(channel_id);
        if(channel instanceof Discord.TextChannel
        || channel instanceof Discord.ThreadChannel
        || channel instanceof Discord.NewsChannel) {
            let messages: Discord.Message[] = [];
            if(block) {
                const fetched_messages = (await channel.messages.fetch({
                    after: forge_snowflake(decode_snowflake(message_id) - 1),
                    limit: 50
                })).map(m => m).reverse();
                const start_time = fetched_messages.length > 0 ? fetched_messages[0].createdTimestamp : undefined;
                const end = index_of_first_not_satisfying(fetched_messages,
                                                          m => m.author.id == fetched_messages[0].author.id
                                                               && m.createdTimestamp - start_time! <= 60 * MINUTE);
                messages = fetched_messages.slice(0, end == -1 ? fetched_messages.length : end);
            } else {
                const quote_message = await channel.messages.fetch(message_id);
                assert(message.member != null);
                messages = [quote_message];
            }
            assert(messages.length >= 1);
            const quote_embeds = await this.make_quote(messages, message.member!);
            const quote = await message.channel.send({ embeds: quote_embeds });
            this.wheatley.deletable.make_message_deletable(message, quote);
            // log
            // TODO: Can probably improve how this is done. Figure out later.
            this.wheatley.staff_message_log.send({
                content: "Message quoted"
                        + `\nIn <#${message.channel.id}> ${message.url}`
                        + `\nFrom <#${channel_id}> ${messages[0].url}`
                        + `\nBy ${message.author.tag} ${message.author.id}`,
                embeds: quote_embeds
            });
            // delete request
            ///message.delete();
        } else {
            message.reply("Error: Channel not a text channel.");
        }
    }
}
