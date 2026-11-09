// grief.js — подозрение на грифинг у новых игроков -> голосование на бан.
// Работает только при включённом античите.

const ac = require("anticheat");
const guard = require("guard");

// ===== Настройки =====
const DANGEROUS_BLOCKS = ["thorium-reactor"]; // внутренние имена блоков, добавляйте свои
// Опасные блоки возле ядра (DANGER_RADIUS_TILES) могут ставить ТОЛЬКО хост и админы.
const DANGER_RADIUS_TILES = 25;               // радиус от ядра (в тайлах)
// --- Кто новичок, решает guard.js (NEWBIE_MINUTES), отдельного таймера входа здесь нет ---
const MAX_PLACE = 5000;                         // больше поставленных блоков за время новичка - подозрение
// --- Таймер действий новичка: перезапускается после КАЖДОГО его действия ---
// Если новичок ACTION_WINDOW_SEC секунд ничего не делал, счётчик серии обнуляется.
const ACTION_WINDOW_SEC = 5;                 // пауза без действий, после которой серия сбрасывается
const MAX_PLACE_BURST = 150;                   // больше поставленных блоков в одной серии - подозрение
const VOTE_SECONDS = 60;                      // сколько длится голосование
const COOLDOWN_SEC = 30;                     // после голосования не запускать новое на того же игрока
const AUTO_ROLLBACK_MINUTES = 5;             // после бана откатить действия игрока за столько минут (0 - не откатывать)

const stats = {};      // uuid -> { place, last: время последнего действия, bPlace }
const cooldown = {};   // uuid -> до какого времени не запускать голосование
const lastMsg = {};    // uuid -> когда последний раз писали ему о запрете
const lastDangerMsg = {}; // uuid -> когда последний раз писали о запрете опасного блока

let vote = null;       // { uuid, name, reason, yes, no, session }
let voteSession = 0;
let warned = false;

// ========== ВСПОМОГАТЕЛЬНОЕ ==========
function findOnline(uuid) {
    let found = null;
    Groups.player.each(p => { if (p.uuid() == uuid) found = p; });
    return found;
}

function countVotes(map) {
    let n = 0;
    if (vote == null) return 0;
    Groups.player.each(p => {
        if (p.uuid() != vote.uuid && map[p.uuid()]) n++;
    });
    return n;
}

function eligible() {
    let n = 0;
    if (vote == null) return 0;
    Groups.player.each(p => { if (p.uuid() != vote.uuid) n++; });
    return n;
}

function needed() {
    return Math.floor(eligible() / 2) + 1;
}

// хост (в игре с хостингом) или админ
function isPrivileged(p) {
    if (Vars.player != null && p == Vars.player) return true;
    if (p.admin) return true;
    return ac.isAdmin(p);
}

function dangerNearCore(p, action) {
    const block = action.block;
    const tile = action.tile;
    if (block == null || tile == null) return false;
    if (DANGEROUS_BLOCKS.indexOf(String(block.name)) < 0) return false;

    const wx = tile.worldx();
    const wy = tile.worldy();
    const r = DANGER_RADIUS_TILES * Vars.tilesize;

    let near = false;
    p.team().data().cores.each(core => {
        if (core.dst(wx, wy) <= r) near = true;
    });
    return near;
}

// IP игрока: у онлайн-игрока берём из соединения, иначе последний известный из базы
function ipOf(p, uuid) {
    try {
        if (p != null && p.con != null && p.con.address != null) return String(p.con.address);
    } catch (e) {}
    try {
        const info = Vars.netServer.admins.getInfo(uuid);
        if (info != null && info.lastIP != null) return String(info.lastIP);
    } catch (e) {}
    return null;
}

// Бан и по uuid, и по IP
function banBoth(uuid, ip) {
    Vars.netServer.admins.banPlayerID(uuid);
    if (ip != null && ip.length > 0) {
        try {
            Vars.netServer.admins.banPlayerIP(ip);
        } catch (e) {
            Log.err("[grief] не удалось забанить IP: " + e);
        }
    }
}

// ========== ГОЛОСОВАНИЕ ==========
function endVote(ban, text) {
    const v = vote;
    if (v == null) return;

    vote = null;
    voteSession++;
    cooldown[v.uuid] = Time.millis() + COOLDOWN_SEC * 1000;

    if (ban) {
        const t = findOnline(v.uuid);
        banBoth(v.uuid, v.ip || ipOf(t, v.uuid));
        if (t != null) t.kick("Бан по голосованию игроков (грифинг)");
        Call.sendMessage("[scarlet][grief][white] " + v.name + "[white] забанен по голосованию.");
        Log.info("[grief] " + v.name + " (" + v.uuid + ") забанен по голосованию: " + v.reason);

        if (AUTO_ROLLBACK_MINUTES > 0) {
            guard.rollback(v.uuid, AUTO_ROLLBACK_MINUTES, (restored, removed) => {
                Call.sendMessage("[scarlet][grief][white] Откат действий " + v.name + "[white]: восстановлено "
                    + restored + ", убрано " + removed);
            });
        }
    } else {
        Call.sendMessage("[scarlet][grief][white] " + text);
    }
}

function checkVote() {
    if (vote == null || !ac.isEnabled()) return;
    const need = needed();
    if (countVotes(vote.yes) >= need) {
        endVote(true);
    } else if (countVotes(vote.no) >= need) {
        endVote(false, "Голосование на бан " + vote.name + "[white] отклонено.");
    }
}

function startBanVote(target, reason) {
    if (!ac.isEnabled() || vote != null) return;
    if (Groups.player.size() < 2) return;

    const until = cooldown[target.uuid()];
    if (until != null && Time.millis() < until) return;

    const session = ++voteSession;
    vote = {
        uuid: target.uuid(),
        name: target.name,
        ip: ipOf(target, target.uuid()),
        reason: reason,
        yes: {},
        no: {},
        session: session
    };

    Call.sendMessage("[scarlet][grief][white] Подозрение на грифинг: " + target.name + "[white] (" + reason
        + "). Голосование на бан, " + VOTE_SECONDS + " с: [orange]/bv[white] - за, [orange]/bv no[white] - против (или /banvote). Нужно голосов: "
        + needed());

    Time.run(60 * VOTE_SECONDS, () => {
        if (vote != null && vote.session == session) {
            // сервер остановили во время голосования - просто сбрасываем его
            if (!ac.isServer()) { vote = null; return; }
            endVote(false, "Голосование на бан " + vote.name + "[white] закончилось без результата.");
        }
    });
}

// ========== ФИЛЬТР ДЕЙСТВИЙ ==========
let filterInstalled = false;

function installActionFilter() {
    if (filterInstalled || !Vars.netServer) return;
    filterInstalled = true;

    Vars.netServer.admins.addActionFilter(action => {
        try {
            const p = action.player;
            if (p == null || !ac.isEnabled()) return true;

            const type = String(action.type);
            if (type != "placeBlock" && type != "breakBlock") return true;

            const uuid = p.uuid();

            // пока идёт голосование, цель не строит и не ломает
            if (vote != null && vote.uuid == uuid) {
                const now = Time.millis();
                if (lastMsg[uuid] == null || now - lastMsg[uuid] > 2000) {
                    lastMsg[uuid] = now;
                    p.sendMessage("[scarlet]Пока идёт голосование против тебя, строить нельзя.");
                }
                return false;
            }

            if (isPrivileged(p)) return true;

            // опасные блоки возле ядра остальным ставить нельзя (для всех, не только новичков)
            const denyDanger = type == "placeBlock" && dangerNearCore(p, action);
            if (denyDanger) {
                const nowD = Time.millis();
                if (lastDangerMsg[uuid] == null || nowD - lastDangerMsg[uuid] > 2000) {
                    lastDangerMsg[uuid] = nowD;
                    p.sendMessage("[scarlet]Этот блок могут ставить только хост и админы.");
                }
                return false;
            }

            if (type != "placeBlock") return true;

            // MAX_PLACE / burst — ТОЛЬКО для новичков по таймеру guard.js (NEWBIE_MINUTES).
            // Доверенные и вышедшие из режима новичка лимит не получают.
            const now = Time.millis();
            if (!guard.isNewbie(p)) {
                delete stats[uuid];
                return true;
            }

            let s = stats[uuid];
            if (s == null) s = stats[uuid] = { place: 0, last: now, bPlace: 0 };

            let reason = null;

            // таймер действий: пауза дольше ACTION_WINDOW_SEC обнуляет серию
            if (now - s.last > ACTION_WINDOW_SEC * 1000) {
                s.bPlace = 0;
            }
            s.last = now;

            s.place++;
            s.bPlace++;
            if (s.place > MAX_PLACE) {
                reason = "слишком много построенных блоков";
            } else if (s.bPlace > MAX_PLACE_BURST) {
                reason = "слишком много построенных блоков подряд (пауза < " + ACTION_WINDOW_SEC + " с)";
            }

            if (reason != null) {
                const until = cooldown[uuid];
                if (vote == null && (until == null || now > until)) {
                    startBanVote(p, reason);
                    return false;
                }
            }

            return true;
        } catch (err) {
            if (!warned) {
                warned = true;
                Log.err("[grief] ошибка в фильтре действий: " + err);
            }
            return true;
        }
    });
}

installActionFilter();
Events.on(ServerLoadEvent, installActionFilter);
Events.on(ClientLoadEvent, installActionFilter);

Events.on(PlayerJoin, e => {
    if (!ac.isServer()) return;
    const now = Time.millis();
    stats[e.player.uuid()] = { place: 0, last: now, bPlace: 0 };
});

Events.on(PlayerLeave, e => {
    const uuid = e.player.uuid();
    delete stats[uuid];
    delete lastMsg[uuid];
    delete lastDangerMsg[uuid];

    if (vote != null) {
        if (vote.uuid == uuid) {
            // выход не отменяет голосование: если проголосуют за, бан по uuid сработает и так
            Call.sendMessage("[scarlet][grief][white] " + vote.name + "[white] вышел, голосование продолжается.");
        } else {
            Time.run(5, checkVote);
        }
    }
});

// ========== КОМАНДА /banvote ==========
function registerCommand() {
    if (!Vars.netServer) return;
    const h = Vars.netServer.clientCommands;

    try { h.removeCommand("banvote"); } catch (e) {}
    try { h.removeCommand("bv"); } catch (e) {}
    try { h.removeCommand("voteclose"); } catch (e) {}
    try { h.removeCommand("vc"); } catch (e) {}

    // Админ/хост единолично закрывает голосование:
    //   /voteclose      - закрыть без бана
    //   /voteclose ban  - закрыть и забанить
    // Короткий алиас: /vc и /vc ban (тот же обработчик).
    const closeRunner = new Packages.arc.util.CommandHandler.CommandRunner({
        accept: function(args, player) {
            try {
                if (!ac.isServer()) return; // сервер не запущен - команды не работают
                if (!isPrivileged(player)) {
                    player.sendMessage("[scarlet]Только для админов.");
                    return;
                }
                if (!ac.isSwitchOn()) {
                    player.sendMessage("[scarlet]Античит выключен.");
                    return;
                }
                if (vote == null) {
                    player.sendMessage("[yellow]Сейчас нет голосования на бан.");
                    return;
                }

                const ban = args.length > 0 && ["ban", "yes", "y", "бан", "да"].indexOf(String(args[0]).toLowerCase()) >= 0;
                const name = vote.name;

                if (ban) {
                    endVote(true);
                } else {
                    endVote(false, "Админ " + player.name + "[white] закрыл голосование на бан " + name + "[white]. Бана нет.");
                }
            } catch (e) {
                Log.err("[grief] " + e);
                player.sendMessage("[scarlet]Ошибка: " + e);
            }
        }
    });

    h.register("voteclose", "[ban]", "Закрыть голосование на бан (админ). /voteclose ban - с баном", closeRunner);
    h.register("vc", "[ban]", "Короткая команда: то же, что /voteclose (/vc ban - с баном)", closeRunner);

    // Один обработчик голоса на две команды: /banvote и короткий алиас /bv
    // (/vote не трогаем - это ванильная команда голосования за кик).
    const voteRunner = new Packages.arc.util.CommandHandler.CommandRunner({
        accept: function(args, player) {
            try {
                if (!ac.isServer()) return; // сервер не запущен - команды не работают
                if (!ac.isSwitchOn()) {
                    player.sendMessage("[scarlet]Античит выключен.");
                    return;
                }
                if (vote == null) {
                    player.sendMessage("[yellow]Сейчас нет голосования на бан.");
                    return;
                }

                const uuid = player.uuid();
                if (uuid == vote.uuid) {
                    player.sendMessage("[scarlet]Ты не можешь голосовать в своём голосовании.");
                    return;
                }

                const against = args.length > 0 && ["no", "n", "нет", "н"].indexOf(String(args[0]).toLowerCase()) >= 0;

                if (against) {
                    if (vote.no[uuid]) {
                        player.sendMessage("[yellow]Ты уже проголосовал против.");
                        return;
                    }
                    delete vote.yes[uuid];
                    vote.no[uuid] = true;
                } else {
                    if (vote.yes[uuid]) {
                        player.sendMessage("[yellow]Ты уже проголосовал за.");
                        return;
                    }
                    delete vote.no[uuid];
                    vote.yes[uuid] = true;
                }

                const name = vote.name;
                const result = [countVotes(vote.yes), countVotes(vote.no), needed()];
                Call.sendMessage("[scarlet][grief][white] " + player.name + "[white] голосует " + (against ? "против" : "за")
                    + " бана " + name + "[white] (за: " + result[0] + ", против: " + result[1] + ", нужно: " + result[2] + ")");

                checkVote();
            } catch (e) {
                Log.err("[grief] " + e);
                player.sendMessage("[scarlet]Ошибка: " + e);
            }
        }
    });

    h.register("banvote", "[n]", "Голосование на бан (/banvote no - против)", voteRunner);
    h.register("bv", "[n]", "Короткая команда: то же, что /banvote (/bv no - против)", voteRunner);
}

registerCommand();
Events.on(ServerLoadEvent, registerCommand);

module.exports = {
    startBanVote: startBanVote
};

