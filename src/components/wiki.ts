import { strict as assert } from "assert";

import * as Discord from "discord.js";
import * as fs from "fs";
import * as path from "path";

import { critical_error, M } from "../utils";
import { colors, is_authorized_admin } from "../common";
import { make_message_deletable } from "./deletable";
import { SlashCommandBuilder } from "discord.js";
import { GuildCommandManager } from "../infra/guild_command_manager";

let client: Discord.Client;

const wiki_dir = "wiki_articles";

async function* walk_dir(dir: string): AsyncGenerator<string> { // todo: duplicate
    for(const f of await fs.promises.readdir(dir)) {
        const file_path = path.join(dir, f).replace(/\\/g, "/");
        if((await fs.promises.stat(file_path)).isDirectory()) {
            yield* walk_dir(file_path);
        } else {
            yield file_path;
        }
    }
}

type WikiArticle = {
    title: string;
    body: string;
    fields: {name: string, value: string, inline: boolean}[],
    footer?: string;
    set_author?: true;
};

const articles: Record<string, WikiArticle> = {};

async function on_message(message: Discord.Message) {
    try {
        if(message.author.bot) return; // Ignore bots
        if(message.content.startsWith("!wiki")
        && is_authorized_admin(message.member!)) {
            M.log("got wiki command");
            const query = message.content.substring("!wiki".length).trim();
            if(query in articles) {
                const article = articles[query];
                const embed = new Discord.EmbedBuilder()
                    .setColor(colors.color)
                    .setTitle(article.title)
                    .setDescription(article.body)
                    .setFields(article.fields);
                if(article.footer) {
                    embed.setFooter({
                        text: article.footer
                    });
                }
                const reply = await message.channel.send({embeds: [embed]});
                make_message_deletable(message, reply);
            }
        }
    } catch(e) {
        critical_error(e);
        try {
            message.reply("Internal error while replying to !wiki");
        } catch(e) {
            critical_error(e);
        }
    }
}

async function on_interaction_create(interaction: Discord.Interaction) {
    if(interaction.isCommand() && interaction.commandName == "echo") {
        assert(interaction.isChatInputCommand());
        const input = interaction.options.getString("input");
        M.debug("echo command", input);
        await interaction.reply({
            ephemeral: true,
            content: input || undefined
        });
    } else if(interaction.isAutocomplete() && interaction.commandName == "wiki") {
        const query = interaction.options.getFocused();
        await interaction.respond(
            Object.values(articles)
                .map(article => article.title)
                .filter(title => title.toLowerCase().includes(query))
                .map(title => ({ name: title, value: title }))
                .slice(0, 25),
        );
    }
}

async function on_ready() {
    try {
        client.on("messageCreate", on_message);
        client.on("interactionCreate", on_interaction_create);
    } catch(e) {
        critical_error(e);
    }
}

function parse_article(content: string): WikiArticle {
    const data: Partial<WikiArticle> = {};
    data.body = "";
    data.fields = [];
    const lines = content.split("\n");
    enum state { body, field, footer };
    let code = false;
    let current_state = state.body;
    for(const line of lines) {
        if(line.trim().startsWith("```")) {
            code = !code;
        }
        if(line.match(/^#(?!#).+$/) && !code) { // H1
            assert(!data.title);
            data.title = line.substring(1).trim();
        } else if(line.match(/^##(?!#).+$/) && !code) { // H2
            let name = line.substring(2).trim();
            let inline = false;
            if(name.match(/^\[.+\]$/)) {
                name = name.substring(1, name.length - 2).trim();
                inline = true;
            }
            data.fields.push({
                name,
                value: "",
                inline
            });
            current_state = state.field;
        } else if(line.trim().toLowerCase() == "<!-- footer -->" && !code) {
            current_state = state.footer;
        } else if(line.trim() == "[[user author]]" && !code) {
            data.set_author = true;
        } else {
            if(current_state == state.body) {
                data.body += `\n${line}`;
            } else if(current_state == state.field) {
                data.fields[data.fields.length - 1].value += `\n${line}`;
            } else if(current_state == state.footer) {
                data.footer = (data.footer ?? "") + `\n${line}`;
            } else {
                assert(false);
            }
        }
    }
    data.body = data.body.trim();
    data.footer = data.footer?.trim();
    assert(data.title);
    assert(data.fields);
    // need to do this nonsense for TS....
    const {title, body, fields, footer, set_author} = data;
    return {
        title, body, fields, footer, set_author
    };
}

async function load_wiki_pages() {
    for await(const file_path of walk_dir(wiki_dir)) {
        const name = path.basename(file_path, path.extname(file_path));
        M.debug(file_path, name);
        if(name == "README") {
            continue;
        }
        const content = await fs.promises.readFile(file_path, {encoding: "utf-8"});
        articles[name] = parse_article(content);
    }
}

export async function setup_wiki(_client: Discord.Client, guild_command_manager: GuildCommandManager) {
    try {
        client = _client;
        const wiki = new SlashCommandBuilder()
            .setName("wiki")
            .setDescription("Retrieve wiki articles")
            .addStringOption(option =>
                option.setName('article_name')
                    .setDescription('Phrase to search for')
                    .setAutocomplete(true));
        guild_command_manager.register(wiki);
        client.on("ready", on_ready);
        await load_wiki_pages();
    } catch(e) {
        critical_error(e);
    }
}
