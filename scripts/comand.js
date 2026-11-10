const S = require("hgsettings"); // числовые настройки берутся из меню: Настройки -> HostGuard

const ac = require("anticheat");

const HELP_PER_PAGE = 6;
const LIST_PER_PAGE = 10; // игроков на странице /list
const NAMES = ["status", "list", "strikes", "unban", "reset", "punish", "skip",
    "disconnect", "admin", "help", "killun", "editor", "infres", "pause"];

// Админские команды: не показываются в /help, их список виден админам в /admin
const ADMIN_ONLY = ["strikes", "unban", "reset", "punish", "skip", "disconnect",
    "log", "rollback", "trust", "untrust", "a",
    "killun", "editor", "infres", "pause"];

// Порядок команд в /help: сверху вниз. Меняйте порядок имён как нужно.
// Команды, которых нет в списке (например, встроенные /t, /votekick), идут
// после этих, по алфавиту.
// "admin" стоит первой: у админов /admin - первая команда в /help.
const HELP_ORDER = ["admin", "list", "log", "rollback", "trust", "skip", "strikes", "reset", "untrust", "unban", "killun", "a", "help", "status", "punish",
    "editor", "infres", "pause", "disconnect"];

function makeRunner(fn) {
    return new Packages.arc.util.CommandHandler.CommandRunner({
        accept: function(args, player) {
            try {
                if (!ac.isServer()) return;
                fn(args, player);
            } catch (e) {
                Log.err("[commands] " + e);
                player.sendMessage("[scarlet]Ошибка: " + e);
            }
        }
    });
}

function adminOnly(fn) {
    return makeRunner(function(args, player) {
        if (!ac.isAdmin(player)) {
            player.sendMessage("[scarlet]Только для админов/хоста.");
            return;
        }
        fn(args, player);
    });
}

function withTarget(fn) {
    return adminOnly(function(args, player) {
        const target = ac.findPlayerByNameOrNumber(args[0]);
        if (!target) {
            player.sendMessage("[scarlet]Игрок не найден. Используй /list");
            return;
        }
        fn(target, player);
    });
}

function showCommandList(h, player, args, admin) {
    const entries = [];
    h.getCommandList().each(cmd => {
        const name = String(cmd.text);
        if ((ADMIN_ONLY.indexOf(name) >= 0) != admin) return;
        if (name == "admin" && !ac.isAdmin(player)) return;
        entries.push({
            name: name,
            line: "[orange]/" + name + "[white] " + cmd.paramText + "\n[lightgray]  " + cmd.description + "\n"
        });
    });

    entries.sort((a, b) => {
        let ia = HELP_ORDER.indexOf(a.name);
        let ib = HELP_ORDER.indexOf(b.name);
        if (ia < 0) ia = HELP_ORDER.length;
        if (ib < 0) ib = HELP_ORDER.length;
        if (ia != ib) return ia - ib;
        return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });
    const list = entries.map(e => e.line);

    const pages = Math.max(1, Math.ceil(list.length / HELP_PER_PAGE));
    const page = args.length > 0 ? parseInt(args[0]) : 1;
    if (isNaN(page) || page < 1 || page > pages) {
        player.sendMessage("[scarlet]Страница должна быть числом от[orange] 1[] до[orange] " + pages + "[scarlet].");
        return;
    }

    let text = "[orange]-- " + (admin ? "Админ-команды" : "Команды") + ", страница[lightgray] " + page
        + "[gray]/[lightgray]" + pages + "[orange] --\n\n";
    const from = (page - 1) * HELP_PER_PAGE;
    for (let k = from; k < Math.min(from + HELP_PER_PAGE, list.length); k++) text += list[k];
    player.sendMessage(text);
}

function registerCommands() {
    if (!Vars.netServer) return;

    const h = Vars.netServer.clientCommands;

    NAMES.forEach(n => { try { h.removeCommand(n); } catch (e) {} });

    h.register("status", "", "Показать свои страйки", makeRunner(function(args, player) {
        const uuid = player.uuid();
        let text = "[accent]Твои данные:[]\n";
        if (!player.isLocal()) text += "Номер: " + ac.idOf(player) + "\n";
        text += "Страйки: " + (ac.strikes[uuid] || 0) + " (PvP: " + (ac.pvpStrikes[uuid] || 0) + ")";
        if (ac.jail[uuid] != null) {
            text += "\n[scarlet]Под наказанием: осталось " + ac.fmt(ac.jail[uuid] / 1000);
        }
        player.sendMessage(text);
    }));

    h.register("list", "[page]", "Список игроков с номерами", makeRunner(function(args, player) {
        const list = ac.getPlayers();

        const pages = Math.max(1, Math.ceil(list.length / LIST_PER_PAGE));
        const page = args.length > 0 ? parseInt(args[0]) : 1;
        if (isNaN(page) || page < 1 || page > pages) {
            player.sendMessage("[scarlet]Страница должна быть числом от[orange] 1[] до[orange] " + pages + "[scarlet].");
            return;
        }

        let text = "[accent]Игроки, страница[lightgray] " + page + "[gray]/[lightgray]" + pages + "[accent]:\n";
        const from = (page - 1) * LIST_PER_PAGE;
        for (let i = from; i < Math.min(from + LIST_PER_PAGE, list.length); i++) {
            var it = list[i];
            var bad = it.strikes > 0 || it.pvp > 0 ? " [gray]— страйки: " + it.strikes + " | PvP: " + it.pvp : "";
            var j = it.jail != null ? " [scarlet](под наказанием " + ac.fmt(it.jail / 1000) + ")" : "";
            text += "[orange]" + it.id + ". [white]" + it.player.name + bad + j + "\n";
        }
        player.sendMessage(text);
    }));

    h.register("strikes", "<player/number>", "Показать страйки игрока", withTarget(function(t, player) {
        const uuid = t.uuid();
        let text = "[accent]" + t.name + "[white]:\n";
        text += "Страйки: " + (ac.strikes[uuid] || 0) + "\n";
        text += "PvP страйки: " + (ac.pvpStrikes[uuid] || 0) + "\n";
        text += ac.jail[uuid] != null ? "[scarlet]В jail: " + ac.fmt(ac.jail[uuid] / 1000) : "[green]Не в jail";
        player.sendMessage(text);
    }));

    h.register("unban", "<player/number>", "Снять наказание", withTarget(function(t, player) {
        if (ac.jail[t.uuid()] == null) {
            player.sendMessage("[yellow]Игрок не в jail.");
            return;
        }
        ac.release(t);
        player.sendMessage("[green]Снял наказание с " + t.name);
    }));

    h.register("reset", "<player/number>", "Обнулить страйки", withTarget(function(t, player) {
        const uuid = t.uuid();
        delete ac.strikes[uuid];
        delete ac.pvpStrikes[uuid];
        if (ac.jail[uuid] != null) ac.release(t);
        if (ac.save) ac.save();
        player.sendMessage("[green]Сбросил страйки " + t.name);
    }));

    h.register("punish", "[derelict/freeze]", "Вид наказания: derelict или freeze (без аргумента - показать)", adminOnly(function(args, player) {
        if (args.length == 0) {
            player.sendMessage("[accent]Вид наказания: [white]" + ac.getPunishMode());
            return;
        }
        const v = String(args[0]).toLowerCase();
        if (v != "derelict" && v != "freeze") {
            player.sendMessage("[scarlet]Укажи derelict или freeze.");
            return;
        }
        ac.setPunishMode(v);
        Call.sendMessage("[scarlet][anticheat][white] " + player.name + "[white]: вид наказания - " + v);
    }));

    h.register("skip", "[count]", "Пропустить волны (1-" + S.get("max_skip") + ")", adminOnly(function(args, player) {
        const n = args.length > 0 ? parseInt(args[0]) : 1;

        if (isNaN(n) || n < 1 || n > S.get("max_skip")) {
            player.sendMessage("[scarlet]Укажи число от 1 до " + S.get("max_skip"));
            return;
        }
        if (!Vars.state.rules.waves) {
            player.sendMessage("[scarlet]На этой карте волны отключены.");
            return;
        }

        for (let i = 0; i < n; i++) Vars.logic.runWave();

        Call.sendMessage("[accent][skip][white] " + player.name + "[white] пропустил волн: " + n);
    }));

    h.register("killun", "[unitType]", "Удалить юнитов твоей команды выбранного типа (без аргумента - всех)", adminOnly(function(args, player) {
        const team = player.team();
        let type = null;
        if (args.length > 0) {
            type = Vars.content.unit(String(args[0]).toLowerCase());
            if (type == null) {
                player.sendMessage("[scarlet]Неизвестный тип юнита: " + args[0]);
                return;
            }
        }

        const victims = [];
        Groups.unit.each(u => {
            if (u.team != team) return;
            if (u.isPlayer()) return;
            if (type != null && u.type != type) return;
            victims.push(u);
        });
        victims.forEach(u => Call.unitDespawn(u));

        Call.sendMessage("[accent][killun][white] " + player.name + "[white] удалил юнитов"
            + (type != null ? " (" + type.name + ")" : "") + ": " + victims.length);
    }));

    h.register("editor", "", "Переключить режим редактора", adminOnly(function(args, player) {
        const v = !Vars.state.rules.editor;
        Vars.state.rules.editor = v;
        Call.setRules(Vars.state.rules);
        Call.sendMessage("[accent][editor][white] " + player.name + "[white]: editor " + (v ? "включён" : "выключен"));
    }));

    h.register("infres", "", "Переключить бесконечные ресурсы", adminOnly(function(args, player) {
        const v = !Vars.state.rules.infiniteResources;
        Vars.state.rules.infiniteResources = v;
        Call.setRules(Vars.state.rules);
        Call.sendMessage("[accent][infres][white] " + player.name + "[white]: бесконечные ресурсы " + (v ? "включены" : "выключены"));
    }));

    h.register("pause", "", "Переключить паузу", adminOnly(function(args, player) {
        const S = Packages.mindustry.core.GameState.State;
        const v = !ac.isPaused();
        Vars.state.set(v ? S.paused : S.playing);
        Call.sendMessage("[accent][pause][white] " + player.name + "[white]: пауза " + (v ? "включена" : "выключена"));
    }));

    h.register("disconnect", "", "Отключить сеть (только хост)", makeRunner(function(args, player) {
        if (!player.isLocal()) {
            player.sendMessage("[scarlet]Только для хоста.");
            return;
        }
        Call.sendMessage("[scarlet][disconnect][white] Сеть отключается...");
        Time.run(60, () => Vars.net.disconnect());
    }));

    h.register("help", "[page]", "Список команд", makeRunner(function(args, player) {
        showCommandList(h, player, args, false);
    }));

    h.register("admin", "[page]", "Список админских команд", adminOnly(function(args, player) {
        showCommandList(h, player, args, true);
    }));

}

registerCommands();
Events.on(ServerLoadEvent, registerCommands);
