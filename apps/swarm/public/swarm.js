/*
 * The live page of the Payminto swarm. No build step and no library: the page is a pure function of the run's events.
 * Live, the events arrive over server-sent events; a replay applies the same recorded events again from the start.
 */
(function () {
  "use strict";

  // ---- small helpers ----

  var $ = function (id) {
    return document.getElementById(id);
  };
  var esc = function (v) {
    return String(v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var ICONS = {
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
    award: '<path d="m15.477 12.89 1.515 8.526a.5.5 0 0 1-.81.47l-3.58-2.687a1 1 0 0 0-1.197 0l-3.586 2.686a.5.5 0 0 1-.81-.469l1.514-8.526"/><circle cx="12" cy="8" r="6"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    right: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    down: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
    seal: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    link: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  };
  var icon = function (name, size, cls) {
    return '<svg class="' + (cls || "") + '" aria-hidden="true" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + "</svg>";
  };

  /** Atomic units to an exact USDC figure: trailing zeros trimmed, at least two decimals, never rounded. */
  var usdcText = function (atomic) {
    var v = BigInt(atomic);
    var neg = v < 0n;
    var digits = (neg ? -v : v).toString().padStart(7, "0");
    var whole = digits.slice(0, digits.length - 6);
    var frac = digits.slice(-6).replace(/0+$/, "").padEnd(2, "0");
    return (neg ? "-" : "") + whole + "." + frac;
  };
  var amt = function (atomic) {
    return '<span class="amt">' + usdcText(atomic) + '<span class="unit">USDC</span></span>';
  };
  var label = function (account) {
    var i = account.indexOf(".");
    return i < 0 ? account : account.slice(0, i);
  };
  /** An account id that never wraps: the middle gives way when space runs out, the last 8 characters always show. */
  var acct = function (account) {
    var cut = Math.max(0, account.length - 8);
    return '<span class="acct" title="' + esc(account) + '"><span class="head">' + esc(account.slice(0, cut)) + '</span><span class="tail">' + esc(account.slice(cut)) + "</span></span>";
  };
  var who = function (account) {
    return '<span class="who"><b>' + nm(account) + "</b>" + acct(account) + "</span>";
  };
  /** An agent's short name. It holds a hyphen, so it is never allowed to wrap. */
  var nm = function (account) {
    return '<span class="nowrap">' + esc(label(account)) + "</span>";
  };
  var pill = function (kind, word) {
    return '<span class="pill ' + kind + '"><i></i>' + esc(word) + "</span>";
  };
  var badge = function (kind, word, ic) {
    return '<span class="badge ' + kind + '">' + (ic ? icon(ic, 12) : "") + esc(word) + "</span>";
  };
  var cmd = function (text) {
    return '<span class="cmd"><code>' + esc(text) + '</code><button type="button" class="ico" data-copy="' + esc(text) + '" aria-label="Copy the command">' + icon("copy", 14) + "</button></span>";
  };
  var plural = function (n, one, many) {
    return n + " " + (n === 1 ? one : many);
  };
  var cap = function (text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  };
  var shortHash = function (h) {
    return h.length > 20 ? h.slice(0, 10) + "..." + h.slice(-8) : h;
  };

  var VOID_TEXT = {
    NOT_REVEALED: "Never opened: the seller did not reveal this bid.",
    LATE_REVEAL: "Opened after the reveal deadline, so it does not count.",
    COMMITMENT_MISMATCH: "The opened bid does not hash to what the seller sealed.",
    ABOVE_RESERVE: "The price is above the reserve price of the round.",
  };
  var RULE_TEXT = {
    TOTAL_CAP: "The Call would take the Budget over its cap.",
    NET_EXPOSURE: "The Budget's unsettled spending would be more than its escrow.",
    PER_CALL_CAP: "The Call was over the Budget's limit per Call.",
    DAILY_CAP: "The Call would take the Budget over its limit for 24 hours.",
    HOURLY_CAP: "The Call would take the Budget over its limit for one hour.",
    PAYEE_NOT_ALLOWED: "This Payee is not on the Budget's list.",
  };

  // ---- the state, as a fold over the events ----

  function fresh() {
    return { meta: null, agents: new Map(), rounds: [], roundBy: new Map(), gross: 0n, calls: 0, settled: null, payout: null, finished: null };
  }

  function pay(s, from, to, amount) {
    var a = BigInt(amount);
    var payer = s.agents.get(from);
    var payee = s.agents.get(to);
    if (payer) {
      payer.paid += a;
      payer.calls++;
    }
    if (payee) payee.received += a;
    s.gross += a;
    s.calls++;
  }

  function apply(s, e) {
    var r = e.round ? s.roundBy.get(e.round) : null;
    switch (e.type) {
      case "run.started":
        s.meta = e;
        e.agents.forEach(function (a) {
          s.agents.set(a.account, { view: a, paid: 0n, received: 0n, calls: 0, refusals: [], ledger: null });
        });
        break;
      case "round.opened":
        r = {
          id: e.round,
          n: e.roundNumber,
          phase: "pooling",
          reserve: e.reserveUnitPrice,
          dataHost: e.dataHost,
          storageSupplier: null,
          demands: 0,
          pooled: 0,
          bids: new Map(),
          result: null,
          buyers: new Map(),
          units: 0,
          received: 0n,
          storage: { count: 0, paid: 0n },
          data: { count: 0, paid: 0n },
          file: null,
          verifyCommand: null,
          verified: null,
          proof: null,
        };
        s.rounds.push(r);
        s.roundBy.set(r.id, r);
        break;
      case "round.demand":
        r.demands++;
        r.pooled += e.units;
        break;
      case "round.pooled":
        r.phase = "commit";
        break;
      case "round.committed":
        r.bids.set(e.seller, { seller: e.seller, seq: e.seq, commitment: e.commitment, unitPrice: null, capacity: null, late: false, status: null, reason: null });
        break;
      case "round.revealed": {
        r.phase = "reveal";
        var b = r.bids.get(e.seller);
        if (b) {
          b.unitPrice = e.unitPrice;
          b.capacity = e.capacity;
          b.late = e.late;
        }
        break;
      }
      case "round.closed":
        r.result = e.result;
        r.storageSupplier = e.storageSupplier;
        r.dataHost = e.dataHost;
        r.phase = e.result.status === "cleared" ? "delivery" : "no-winner";
        e.result.bids.forEach(function (x) {
          var bid = r.bids.get(x.seller);
          if (bid) {
            bid.status = x.status;
            bid.reason = x.reason;
          }
        });
        e.result.allocations.forEach(function (a) {
          r.buyers.set(a.buyer, { buyer: a.buyer, asked: a.demanded, units: a.units, share: a.share, delivered: 0, paid: 0n, stop: null });
        });
        break;
      case "unit.delivered": {
        var d = r.buyers.get(e.buyer);
        if (d) {
          d.delivered++;
          d.paid += BigInt(e.amount);
        }
        r.units++;
        r.received += BigInt(e.amount);
        pay(s, e.buyer, e.seller, e.amount);
        break;
      }
      case "unit.stopped": {
        var st = r.buyers.get(e.buyer);
        if (st) st.stop = e.stop;
        var ag = s.agents.get(e.buyer);
        if (ag && e.stop.cause === "refused") ag.refusals.push({ round: r.n, stop: e.stop });
        break;
      }
      case "input.bought":
        r[e.input].count++;
        r[e.input].paid += BigInt(e.amount);
        pay(s, e.seller, e.from, e.amount);
        break;
      case "round.delivered":
        if (r.phase === "delivery") r.phase = "delivered";
        r.file = e.file;
        r.verifyCommand = e.verifyCommand;
        r.verified = e.verified;
        break;
      case "settled":
        s.settled = e;
        break;
      case "paid.out":
        s.payout = e;
        break;
      case "proof": {
        var pr = s.roundBy.get(e.proof.round);
        if (pr) pr.proof = e.proof;
        break;
      }
      case "ledger":
        e.agents.forEach(function (l) {
          var a = s.agents.get(l.account);
          if (a) a.ledger = l;
        });
        break;
      case "run.finished":
        s.finished = e;
        break;
    }
  }

  /** What would move if the node settled now: each account's net position, creditors summed. */
  function projection(s) {
    var net = 0n;
    var creditors = 0;
    s.agents.forEach(function (a) {
      var position = a.received - a.paid;
      if (position > 0n) {
        net += position;
        creditors++;
      }
    });
    return { net: net, creditors: creditors };
  }

  // ---- rendering ----

  var state = fresh();
  var dirty = new Set();
  var openShares = new Map();
  var agentFilter = "all";
  var frame = 0;

  function mark() {
    for (var i = 0; i < arguments.length; i++) dirty.add(arguments[i]);
    if (!frame) frame = requestAnimationFrame(flush);
  }
  function markFor(e) {
    mark("state", "clearing");
    if (e.round) mark("round:" + e.round);
    if (e.type === "run.started") mark("meta", "agents");
    if (e.type === "unit.delivered" || e.type === "unit.stopped" || e.type === "input.bought" || e.type === "ledger") mark("agents");
    if (e.type === "proof") {
      mark("round:" + e.proof.round);
      setTimeout(openWanted, 0);
    }
    if (e.type === "settled" || e.type === "paid.out" || e.type === "ledger") {
      mark("settlement", "agents");
      state.rounds.forEach(function (r) {
        mark("round:" + r.id);
      });
    }
    if (e.type === "run.finished") mark("checks");
  }
  function markAll() {
    mark("meta", "state", "clearing", "agents", "settlement", "checks", "rounds");
  }

  function flush() {
    frame = 0;
    var s = state;
    if (dirty.has("rounds")) {
      $("rounds").innerHTML = "";
      s.rounds.forEach(function (r) {
        dirty.add("round:" + r.id);
      });
      if (s.rounds.length === 0) $("rounds").innerHTML = '<div class="panel"><div class="pad empty">No round is open yet. The first one appears here as soon as the run starts.</div></div>';
    }
    dirty.forEach(function (key) {
      if (key === "meta") renderMeta(s);
      else if (key === "state") renderState();
      else if (key === "clearing") renderClearing(s);
      else if (key === "agents") renderAgents(s);
      else if (key === "settlement") renderSettlement(s);
      else if (key === "checks") renderChecks(s);
      else if (key.indexOf("round:") === 0) renderRound(s, s.roundBy.get(key.slice(6)));
    });
    dirty.clear();
  }

  function renderMeta(s) {
    var m = s.meta;
    if (!m) {
      $("chain-badge").textContent = "Connecting";
      return;
    }
    var buyers = m.agents.filter(function (a) {
      return a.role === "buyer";
    }).length;
    var sellers = m.agents.length - buyers;
    $("chain-badge").textContent = m.simulated ? "SIMULATED" : "SANDBOX";
    $("chain-badge").title = m.label;
    $("lede").innerHTML =
      "You are watching <b>" + plural(buyers, "buyer agent", "buyer agents") + "</b> pool their demand for GPU hours and <b>" + plural(sellers, "seller agent", "seller agents") +
      "</b> compete for it with sealed bids, over <b>" + plural(m.rounds, "round", "rounds") + "</b>. " +
      "Payminto pays the winner one signed voucher per delivered unit, then settles everything in a few transfers. " +
      "Chain state on this page is " + esc(m.label) + ".";
    $("agents-desc").innerHTML = "Every agent is its own sub-account of " + acct(m.parent) + ", with its own key and its own Budget on the hub " + acct(m.hub) + ".";
  }

  function phaseWords(s) {
    if (s.finished) return "the run is over: " + (s.finished.ok ? "every check passed" : "a check failed");
    if (s.payout) return "paid out, proving one receipt per round";
    if (s.settled) return "settled on the hub, paying out";
    var r = s.rounds[s.rounds.length - 1];
    if (!r) return s.meta ? "the agents have their Budgets" : "";
    var total = s.meta ? s.meta.rounds : s.rounds.length;
    var words = { pooling: "buyers are pooling demand", commit: "sellers are sealing bids", reveal: "sellers are opening bids", delivery: "units are being delivered and paid", delivered: "delivered", "no-winner": "no winner" }[r.phase];
    return "round " + r.n + " of " + total + ", " + words;
  }

  function renderState() {
    var over = events.some(function (e) {
      return e.type === "run.finished";
    });
    var text;
    var on = false;
    if (events.length === 0) text = "<b>Waiting for the run to start</b>";
    else if (following && !over) {
      text = "<b>Live</b><span class=\"muted\">" + esc(phaseWords(state)) + "</span>";
      on = true;
    } else if (following) text = "<b>The run is over</b><span class=\"muted\">Press Replay to watch it from the start, or drag the slider to any moment.</span>";
    else if (playing) {
      text = "<b>Replaying at " + speed + "x</b><span class=\"muted\">" + esc(phaseWords(state)) + "</span>";
      on = true;
    } else text = "<b>Paused</b><span class=\"muted\">" + esc(phaseWords(state)) + "</span>";
    $("state").innerHTML = '<span class="livedot' + (on ? " on" : "") + '"></span>' + text;
    $("replay").disabled = events.length === 0;
    $("pause").disabled = events.length === 0 || (following && over);
    $("pause").textContent = following || playing ? "Pause" : "Play";
    $("scrub").disabled = events.length === 0;
    $("scrub").max = String(events.length);
    $("scrub").value = String(cursor);
    $("count").textContent = cursor + " of " + plural(events.length, "event", "events");
  }

  function renderClearing(s) {
    var settled = s.settled;
    var p = projection(s);
    var gross = settled ? BigInt(settled.gross) : s.gross;
    var net = settled ? BigInt(settled.net) : p.net;
    var calls = settled ? settled.calls : s.calls;
    var transfers = s.payout ? s.payout.transfers.length : p.creditors;
    var offset = gross - net;
    var share = gross > 0n ? Number((net * 10000n) / gross) / 100 : 0;
    $("clearing-tags").innerHTML = s.calls === 0 && !settled ? "" : settled ? pill("settled", "Settled") : pill("waiting", "Waiting");
    $("clearing-desc").textContent = settled
      ? "Settled on the hub: these are the hub's own figures for the batch."
      : "Every paid Call adds to the gross. The net is what would move if the clearing node settled now.";
    var fewer = transfers > 0 && calls > transfers ? '<span class="fewer">' + calls + " Calls, " + plural(transfers, "transfer", "transfers") + "</span>" : "";
    $("clearing").innerHTML =
      '<div class="bs">' +
      '<div class="bs-side"><p class="over">One transfer per Call</p>' +
      '<div class="count-row"><b>' + calls + '</b><span class="muted">paid ' + (calls === 1 ? "Call" : "Calls") + "</span></div>" +
      '<div class="line">' + amt(gross) + '<span class="muted">gross cleared</span></div></div>' +
      '<div class="bs-mid"><span class="bs-arrow">' + icon("right", 16, "rt") + icon("down", 16, "dn") + "</span>" + fewer + "</div>" +
      '<div class="bs-side"><p class="over p">With Payminto</p>' +
      '<div class="count-row"><b>' + transfers + '</b><span class="muted">' + (s.payout ? (transfers === 1 ? "token transfer" : "token transfers") : transfers === 1 ? "account to pay" : "accounts to pay") + "</span></div>" +
      '<div class="line">' + amt(net) + '<span class="muted">' + (settled ? "net moved" : "net, if settled now") + "</span></div></div>" +
      "</div>" +
      '<div class="ratio"><div class="meter" role="img" aria-label="Net is ' + share + ' percent of gross"><span style="width:' + share + '%"></span><span class="offset" style="width:' + (gross > 0n ? 100 - share : 0) + '%"></span></div>' +
      '<div class="keys"><div><i></i><span>Net ' + (settled ? "moved" : "to move") + ": " + usdcText(net) + " USDC</span></div><div><i class=\"offset\"></i><span>Offset between owners: " + usdcText(offset) + " USDC</span></div></div></div>";
  }

  var PHASE = {
    pooling: ["secondary", "Pooling demand"],
    commit: ["secondary", "Sealing bids"],
    reveal: ["secondary", "Opening bids"],
    delivery: ["info", "Delivering"],
    delivered: ["outline", "Delivered"],
    "no-winner": ["outline", "No winner"],
  };

  function bidChip(r, b) {
    if (r.result) {
      if (b.status === "void") return badge("void", "Void", "ban");
      if (r.result.winner === b.seller) return badge("default", "Winner", "award");
      return badge("info", "Revealed", "check");
    }
    if (b.unitPrice !== null) return b.late ? badge("void", "Opened late", "ban") : badge("info", "Revealed", "check");
    return badge("secondary", "Sealed", "lock");
  }

  function renderBids(s, r) {
    if (r.bids.size === 0) return '<p class="empty">' + (r.phase === "pooling" ? "Sellers bid after the pool closes." : "No seller has sealed a bid yet.") + "</p>";
    var out = '<ul class="bids">';
    r.bids.forEach(function (b) {
      var agent = s.agents.get(b.seller);
      var price = b.unitPrice === null ? '<span class="muted">hidden</span>' : amt(b.unitPrice) + "<small>per unit, up to " + b.capacity + " units</small>";
      var why = b.status === "void" ? '<p class="why">' + esc(VOID_TEXT[b.reason] || b.reason) + "</p>" : "";
      out +=
        '<li class="' + (b.status === "void" ? "is-void" : "") + '">' +
        '<div class="who-line"><b>' + nm(b.seller) + "</b>" + bidChip(r, b) + (agent ? '<span class="muted" title="' + esc(agent.view.strategyText) + '">script: ' + esc(agent.view.strategy) + "</span>" : "") + "</div>" +
        '<div class="price">' + price + "</div>" +
        '<div class="hash mono" title="The sealed commitment: SHA-256 of the bid and a salt">sealed as ' + esc(shortHash(b.commitment)) + "</div>" +
        why +
        "</li>";
    });
    return out + "</ul>";
  }

  function renderResult(s, r) {
    var res = r.result;
    if (!res) return "";
    if (res.status !== "cleared") {
      return '<p class="note"><b>No winner.</b> ' + (res.status === "no-demand" ? "No buyer asked for units." : "No bid was valid.") + " Nothing is delivered and nothing is paid.</p>";
    }
    var valid = res.bids.filter(function (b) {
      return b.status === "valid";
    }).length;
    var rationed = res.awardedUnits < res.pooledUnits;
    return (
      '<dl class="tiles">' +
      '<div class="tile"><dt>Clearing price per unit</dt><dd>' + amt(res.clearingPrice) + "</dd><small>" + (valid > 1 ? "The second-lowest valid bid. " : "The reserve price: only one bid was valid. ") + nm(res.winner) + " bid " + usdcText(res.winnerUnitPrice) + ".</small></div>" +
      '<div class="tile"><dt>Units awarded</dt><dd><span class="big">' + res.awardedUnits + " of " + res.pooledUnits + "</span></dd><small>" + (rationed ? "The winner's capacity. Split in proportion to demand." : "Every buyer gets all it asked for.") + "</small></div>" +
      '<div class="tile wide"><dt>Delivered and paid so far</dt><dd><span class="big">' + r.units + " of " + res.awardedUnits + ' units</span> <span class="muted">for</span> ' + amt(r.received) + "</dd><small>One paid Call per unit, at exactly the clearing price. The pool owes at most " + usdcText(res.totalDue) + " USDC.</small></div>" +
      "</dl>"
    );
  }

  function shareStatus(s, b) {
    if (b.stop && b.stop.cause === "refused") return pill("refused", "Refused");
    if (b.stop) return badge("secondary", "Seller stopped");
    if (b.units === 0) return '<span class="muted">-</span>';
    if (b.delivered < b.units) return '<span class="muted">' + (b.delivered === 0 ? "Queued" : "In delivery") + "</span>";
    return s.settled ? pill("settled", "Settled") : pill("waiting", "Waiting");
  }

  function stopReason(b) {
    var st = b.stop;
    if (!st) return "";
    if (st.cause === "refused") {
      return (
        '<div class="reason"><span><b>Refusal: ' + esc(st.rule) + ".</b> " + esc(RULE_TEXT[st.rule] || "A Budget rule stopped the Call.") +
        " Unit " + st.atUnit + " at " + usdcText(st.attemptedAmount || "0") + " USDC, stopped by " + (st.enforcedBy === "agent" ? "the buyer's own client before it signed" : "the clearing node") + '.</span><span class="none-moved"><i></i>No money moved</span></div>'
      );
    }
    if (st.cause === "seller-unavailable") return '<div class="reason"><span>The seller stopped serving before unit ' + st.atUnit + '. No voucher was signed for it.</span><span class="none-moved"><i></i>No money moved</span></div>';
    return '<div class="reason"><span>Unit ' + st.atUnit + " did not arrive, so the buyer stopped.</span></div>";
  }

  function renderShares(s, r) {
    if (!r.result || r.result.status !== "cleared") return '<p class="empty">Each buyer\'s share appears when the round closes.</p>';
    var rows =
      '<div class="row head"><span>Buyer</span><span class="r">Asked</span><span class="r">Allocated</span><span class="r">Share</span><span>Delivered</span><span class="r">Paid</span><span class="r">Status</span></div>';
    r.buyers.forEach(function (b) {
      var pct = b.units > 0 ? Math.round((b.delivered / b.units) * 100) : 0;
      rows +=
        '<div class="row">' +
        '<span class="c-who"><b style="font-weight:500">' + nm(b.buyer) + "</b></span>" +
        '<span class="c-asked r num">' + b.asked + "</span>" +
        '<span class="c-alloc r num"><span class="lab">asked ' + b.asked + ", allocated </span>" + b.units + '<span class="lab"> ' + (b.units === 1 ? "unit" : "units") + ", share " + usdcText(b.share) + " USDC</span></span>" +
        '<span class="c-share r">' + amt(b.share) + "</span>" +
        '<span class="c-bar unitbar"><span class="meter sm" role="img" aria-label="' + b.delivered + " of " + b.units + ' units delivered"><span style="width:' + pct + '%"></span></span><span class="num muted nowrap">' + b.delivered + " of " + b.units + "</span></span>" +
        '<span class="c-paid r"><span class="lab">paid </span>' + amt(b.paid) + "</span>" +
        '<span class="c-st r">' + shareStatus(s, b) + "</span>" +
        stopReason(b) +
        "</div>";
    });
    return '<div class="rows shares">' + rows + "</div>";
  }

  function renderRound(s, r) {
    if (!r) return;
    var host = $("rounds");
    var el = document.getElementById("round-" + r.n);
    if (!el) {
      el = document.createElement("article");
      el.className = "panel round";
      el.id = "round-" + r.n;
      el.setAttribute("aria-label", "Round " + r.n);
      // The newest round sits on top, so the one in progress is always the first thing under the legend.
      var first = host.firstElementChild;
      if (first && !first.id) host.innerHTML = "";
      host.insertBefore(el, host.firstElementChild);
    }
    var ph = PHASE[r.phase];
    var isLatest = s.rounds[s.rounds.length - 1] === r;
    // On a phone the list of buyers starts folded, so the bids and the result of the round stay on one screen.
    var open = openShares.has(r.id) ? openShares.get(r.id) : isLatest && !matchMedia("(max-width: 767px)").matches;
    var tags = badge(ph[0], ph[1]);
    if (r.phase === "delivered") tags += s.settled ? pill("settled", "Settled") : pill("waiting", "Waiting");
    var pool = r.demands === 0 ? "Buyers are joining the pool." : plural(r.demands, "buyer", "buyers") + " asked for " + plural(r.pooled, "GPU-hour", "GPU-hours") + ".";
    var winner = r.result && r.result.winner;
    var inputs = "";
    if (winner && (r.storage.count > 0 || r.data.count > 0)) {
      var parts = [];
      if (r.storage.count > 0 && r.storageSupplier) parts.push(plural(r.storage.count, "storage block", "storage blocks") + " from <b>" + nm(r.storageSupplier) + "</b> for " + usdcText(r.storage.paid) + " USDC");
      if (r.data.count > 0 && r.dataHost) parts.push(plural(r.data.count, "dataset shard", "dataset shards") + " from <b>" + nm(r.dataHost) + "</b> for " + usdcText(r.data.paid) + " USDC");
      inputs = '<p class="note">To deliver, <b>' + nm(winner) + "</b> bought " + parts.join(" and ") + ". These are paid Calls too, so sellers and data hosts owe each other, and that is what the clearing node offsets.</p>";
    }
    var foot = "";
    if (r.file) {
      foot =
        '<div class="panel-foot">' +
        '<div class="foot-links"><a class="btn outline sm" href="/files/' + esc(r.file) + '" target="_blank" rel="noreferrer">Open round file ' + icon("link", 14) + "</a>" +
        (r.proof ? '<a class="btn primary sm" href="#proof-' + r.n + '" data-proof="' + r.n + '">Open Proof of one Call</a>' : '<span class="muted">The Proof of one Call appears after settlement.</span>') +
        "</div>" +
        cmd(r.verifyCommand) +
        "</div>";
    }
    var count = r.buyers.size;
    el.innerHTML =
      '<div class="panel-head"><div class="titles"><h2>Round ' + r.n + '</h2><p>' + pool + " Reserve price " + usdcText(r.reserve) + " USDC per unit.</p></div><div class=\"tags\">" + tags + "</div></div>" +
      '<div class="round-body">' +
      '<div class="round-col"><p class="sub-title">Sealed bids <span>from ' + plural(r.bids.size, "seller", "sellers") + "</span></p>" + renderBids(s, r) + renderResult(s, r) + inputs + "</div>" +
      '<div class="round-col"><p class="sub-title">Each buyer pays only its share <span>' + (count ? "- " + plural(count, "buyer", "buyers") : "") + "</span></p>" +
      (count && !open ? '<p class="empty">' + r.units + " units delivered to " + plural(count, "buyer", "buyers") + ".</p>" : renderShares(s, r)) +
      (count ? '<p style="margin-top:12px"><button type="button" class="btn outline sm" data-toggle="' + esc(r.id) + '" aria-expanded="' + (open ? "true" : "false") + '">' + (open ? "Hide the buyers" : "Show all " + count + " buyers") + "</button></p>" : "") +
      "</div></div>" +
      foot;
  }

  function afterText(a, s) {
    var l = a.ledger;
    if (!l) return '<span class="muted">' + (s.settled ? "-" : "not settled yet") + "</span>";
    var fall = BigInt(l.escrowBefore) - BigInt(l.escrowAfter);
    var out = BigInt(l.paidOut);
    if (out > 0n) return '<span class="stack">' + amt(out) + "<small>paid out to its wallet</small></span>";
    if (fall > 0n) return '<span class="stack">' + amt(fall) + "<small>debited from its escrow</small></span>";
    return '<span class="muted">nothing moved</span>';
  }

  function renderAgents(s) {
    if (s.agents.size === 0) {
      $("agents").innerHTML = '<p class="empty">The agents appear when the run starts.</p>';
      return;
    }
    var rows =
      '<div class="row head"><span>Agent and sub-account</span><span>Script</span><span>Budget used</span><span class="r">Paid</span><span class="r">Received</span><span class="r">At settlement</span></div>';
    var shown = 0;
    s.agents.forEach(function (a) {
      var v = a.view;
      if (agentFilter === "buyer" && v.role !== "buyer") return;
      if (agentFilter === "seller" && v.role !== "seller") return;
      if (agentFilter === "refused" && a.refusals.length === 0) return;
      shown++;
      var cap = BigInt(v.cap);
      var pct = cap > 0n ? Math.min(100, Number((a.paid * 10000n) / cap) / 100) : 0;
      var tags = badge("outline", v.role === "buyer" ? "Buyer" : "Seller") + (v.dataHost ? badge("outline", "Data host") : "") + (a.refusals.length ? pill("refused", plural(a.refusals.length, "Refusal", "Refusals")) : "");
      rows +=
        '<div class="row">' +
        '<div class="c-who who"><span class="name-line"><b>' + esc(v.label) + "</b>" + tags + "</span>" + acct(v.account) + "</div>" +
        '<div class="c-strategy" title="' + esc(v.strategyText) + '">' + esc(v.strategy) + "</div>" +
        '<div class="c-budget budget"><span class="meter sm" role="img" aria-label="' + pct + ' percent of the Budget cap used"><span style="width:' + pct + '%"></span></span><span class="cap"><span>' + usdcText(a.paid) + " of " + usdcText(v.cap) + " USDC cap</span><span>escrow " + usdcText(v.escrow) + " USDC</span></span></div>" +
        '<div class="c-paid r"><span class="lab">Paid in ' + plural(a.calls, "Call", "Calls") + "</span>" + amt(a.paid) + "</div>" +
        '<div class="c-received r"><span class="lab">Received</span>' + amt(a.received) + "</div>" +
        '<div class="c-after r"><span class="lab">At settlement</span>' + afterText(a, s) + "</div>" +
        "</div>";
    });
    if (shown === 0) rows += '<p class="empty" style="padding-top:12px">No agent matches this filter yet.</p>';
    $("agents").innerHTML = rows;
  }

  function renderSettlement(s) {
    var st = s.settled;
    $("settle-tags").innerHTML = st ? pill("settled", "Settled") : "";
    if (!st) {
      $("settlement").innerHTML = '<p class="empty">Nothing is settled yet. Payments so far are signed vouchers the clearing node has accepted.</p>';
      return;
    }
    var batch = st.batches[0];
    var debtors = 0;
    var debited = 0n;
    s.agents.forEach(function (a) {
      if (!a.ledger) return;
      var fall = BigInt(a.ledger.escrowBefore) - BigInt(a.ledger.escrowAfter);
      if (fall > 0n) {
        debtors++;
        debited += fall;
      }
    });
    var html =
      '<dl class="facts">' +
      '<div class="f"><dt>Settlement batches</dt><dd>' + plural(st.batches.length, "settle_batch call", "settle_batch calls") + " for " + plural(st.calls, "paid Call", "paid Calls") + "</dd></div>" +
      (batch ? '<div class="f"><dt>Root stored on the hub</dt><dd class="hash" title="The Merkle root of the batch\'s Calls">' + esc(batch.root) + "</dd></div>" : "") +
      (debtors ? '<div class="f"><dt>Escrow debited</dt><dd>' + amt(debited) + ' <span class="muted">from ' + plural(debtors, "account", "accounts") + ", each by its own net amount</span></dd></div>" : "") +
      "</dl>";
    if (s.payout) {
      html += '<p class="sub-title" style="margin-top:16px">Token transfers <span>- one per net creditor, in ' + plural(s.payout.transactions, "payout call", "payout calls") + "</span></p><ul class=\"transfers\">";
      s.payout.transfers.forEach(function (t) {
        html += "<li>" + who(t.account) + '<span class="right">' + amt(t.amount) + pill("settled", "Settled") + "</span></li>";
      });
      html += "</ul>";
    } else html += '<p class="note">Paying out the net creditors.</p>';
    $("settlement").innerHTML = html;
  }

  function renderChecks(s) {
    var f = s.finished;
    $("checks-tags").innerHTML = f ? (f.ok ? pill("settled", "All passed") : pill("refused", "A check failed")) : "";
    if (!f) {
      $("checks").innerHTML = '<p class="empty">The table and the checks appear when the run ends.</p>';
      return;
    }
    var html = '<dl class="facts">';
    f.table.forEach(function (row) {
      html += '<div class="f"><dt>' + esc(cap(row.measure)) + '</dt><dd class="num">' + esc(row.value) + "</dd></div>";
    });
    html += '</dl><p class="sub-title" style="margin-top:16px">Checks <span>- the command exits with an error if one fails</span></p><ul class="checks">';
    f.checks.forEach(function (c) {
      html += '<li><span class="tick' + (c.ok ? "" : " bad") + '">' + icon(c.ok ? "check" : "x", 12) + '</span><span class="txt">' + esc(cap(c.name)) + "<small>" + esc(c.detail) + "</small></span></li>";
    });
    $("checks").innerHTML = html + "</ul>";
  }

  // ---- the Proof of one Call ----

  function openProof(n) {
    var r = state.rounds.filter(function (x) {
      return x.n === n;
    })[0];
    var p = r && r.proof;
    if (!p) return;
    var body = $("proof-body");
    var m = state.meta;
    var head = function (cls, title, text) {
      return '<div class="verdict ' + cls + '"><span class="seal">' + icon(cls === "bad" ? "alert" : "seal", 24) + "</span><div><h3>" + esc(title) + "</h3><p>" + esc(text) + "</p></div></div>";
    };
    var facts =
      '<dl class="facts">' +
      '<div class="f"><dt>The Call</dt><dd><b style="font-weight:500">' + nm(p.buyer) + "</b> paid <b style=\"font-weight:500\">" + nm(p.seller) + "</b> " + amt(p.amount) + " for one GPU-hour of round " + p.roundNumber + "</dd></div>" +
      '<div class="f"><dt>Budget owner</dt><dd>' + acct(p.buyer) + "</dd></div>" +
      '<div class="f"><dt>Payee</dt><dd>' + acct(p.seller) + "</dd></div>" +
      '<div class="f"><dt>Settlement batch</dt><dd class="hash">' + esc(p.batchId) + "</dd></div>" +
      '<div class="f"><dt>Path to the root</dt><dd>' + plural(p.steps, "step", "steps") + " from this Call to the root the hub stores</dd></div>" +
      "</dl>";
    var check =
      '<div><p class="sub-title">Check it yourself</p>' + cmd(p.command) +
      '<p class="note">The command re-checks the file with no node: the voucher signature against the buyer\'s key, and the path against the recorded root. ' +
      'A copy with the amount raised by one atomic unit is written next to it and fails the same check.</p>' +
      '<p style="margin-top:12px;display:flex;flex-wrap:wrap;gap:8px"><a class="btn outline sm" href="/files/' + esc(p.file) + '" target="_blank" rel="noreferrer">Open the receipt file ' + icon("link", 14) + '</a><a class="btn outline sm" href="/files/' + esc(p.tamperedFile) + '" target="_blank" rel="noreferrer">Open the tampered copy ' + icon("link", 14) + "</a></p></div>";
    var tail = '<p class="note">A Proof shows that the Call is in a settled batch and that the buyer\'s key signed it. It does not show that the GPU work was done.</p>';
    body.innerHTML = head("", "Checking against the hub", "Asking the hub of this run for the batch root.") + facts + check + tail;
    var dialog = $("proof");
    if (!dialog.open) dialog.showModal();
    fetch("/api/receipts/" + n)
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .catch(function () {
        return null;
      })
      .then(function (j) {
        var live = j && j.live;
        var verdict;
        var lines = "";
        if (live) {
          verdict = live.ok
            ? head("ok", "Verified against the hub", "Checked just now against the " + (m && m.simulated ? "simulated hub" : "sandbox hub") + " of this run: " + (m ? m.label : "") + ".")
            : head("bad", "Not verified", "The hub of this run does not confirm this receipt.");
          lines = '<ul class="checks">';
          live.lines.forEach(function (l) {
            lines += '<li><span class="tick' + (l.ok === false ? " bad" : "") + '"' + (l.ok === null ? ' style="background:var(--muted);color:var(--muted-foreground)"' : "") + ">" + icon(l.ok === false ? "x" : "check", 12) + '</span><span class="txt">' + esc(cap(l.what)) + "<small>" + esc(l.detail) + "</small></span></li>";
          });
          lines += "</ul>";
        } else {
          verdict = p.verified
            ? head("ok", "Verified during the run", "The run proved this receipt against the hub when it settled. The live check is not reachable now.")
            : head("bad", "Not verified", p.reason || "The run could not prove this receipt.");
        }
        if (dialog.open) body.innerHTML = verdict + facts + check + (lines ? '<div><p class="sub-title">What the hub confirmed</p>' + lines + "</div>" : "") + tail;
      });
  }

  // ---- playback ----

  var events = [];
  var cursor = 0;
  var following = true;
  var playing = false;
  var speed = 4;
  var timer = 0;
  var STEP_MS = 60;

  function rebuild(to) {
    state = fresh();
    cursor = 0;
    while (cursor < to) apply(state, events[cursor++]);
    markAll();
  }
  function advance(n) {
    var end = Math.min(events.length, cursor + n);
    while (cursor < end) {
      var e = events[cursor++];
      apply(state, e);
      markFor(e);
    }
    mark("state");
  }
  function stopTimer() {
    clearInterval(timer);
    timer = 0;
    playing = false;
  }
  function play() {
    stopTimer();
    following = false;
    playing = true;
    timer = setInterval(function () {
      advance(speed);
      if (cursor >= events.length) {
        stopTimer();
        following = true;
        mark("state");
      }
    }, STEP_MS);
    mark("state");
  }

  $("replay").addEventListener("click", function () {
    rebuild(0);
    play();
  });
  $("pause").addEventListener("click", function () {
    if (following || playing) {
      stopTimer();
      following = false;
      mark("state");
    } else play();
  });
  $("speed").addEventListener("change", function (ev) {
    speed = Number(ev.target.value) || 1;
    mark("state");
  });
  $("scrub").addEventListener("input", function (ev) {
    stopTimer();
    following = false;
    rebuild(Number(ev.target.value));
  });

  document.addEventListener("click", function (ev) {
    var t = ev.target.closest("[data-copy],[data-toggle],[data-proof],.chip");
    if (!t) return;
    if (t.hasAttribute("data-copy")) {
      var idle = t.innerHTML;
      var done = function () {
        t.classList.add("done");
        t.innerHTML = icon("check", 14);
        t.setAttribute("aria-label", "Copied");
        setTimeout(function () {
          t.classList.remove("done");
          t.innerHTML = idle;
          t.setAttribute("aria-label", "Copy the command");
        }, 1200);
      };
      try {
        navigator.clipboard.writeText(t.getAttribute("data-copy")).then(done, done);
      } catch (e) {
        done();
      }
    } else if (t.hasAttribute("data-toggle")) {
      var id = t.getAttribute("data-toggle");
      openShares.set(id, t.getAttribute("aria-expanded") !== "true");
      mark("round:" + id);
    } else if (t.hasAttribute("data-proof")) {
      // The link carries #proof-<round>, so a Proof can be bookmarked and sent to someone else.
      ev.preventDefault();
      history.replaceState(null, "", "#proof-" + t.getAttribute("data-proof"));
      openProof(Number(t.getAttribute("data-proof")));
    } else if (t.classList.contains("chip")) {
      agentFilter = t.getAttribute("data-f");
      document.querySelectorAll("#agent-filters .chip").forEach(function (c) {
        c.setAttribute("aria-pressed", c === t ? "true" : "false");
      });
      mark("agents");
    }
  });
  $("proof-close").innerHTML = icon("x", 16);
  $("proof-close").addEventListener("click", function () {
    $("proof").close();
  });
  $("proof").addEventListener("close", function () {
    if (/^#proof-/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
  });
  /** Opens the Proof named in the address, once its round has one. */
  var wanted = /^#proof-([0-9]+)$/.exec(location.hash);
  function openWanted() {
    if (!wanted) return;
    var n = Number(wanted[1]);
    var has = state.rounds.some(function (r) {
      return r.n === n && r.proof;
    });
    if (!has) return;
    wanted = null;
    openProof(n);
  }
  $("proof").addEventListener("click", function (ev) {
    // A click on the backdrop closes the dialog; a click inside it does not.
    if (ev.target === $("proof")) $("proof").close();
  });

  // ---- theme ----

  var themeButton = $("theme");
  function paintTheme() {
    themeButton.textContent = document.documentElement.getAttribute("data-theme") === "dark" ? "Light" : "Dark";
  }
  themeButton.addEventListener("click", function () {
    var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("payminto-swarm-theme", next);
    } catch (e) {}
    paintTheme();
  });
  paintTheme();
  document.querySelectorAll("[data-icon]").forEach(function (el) {
    el.insertAdjacentHTML("afterbegin", icon(el.getAttribute("data-icon"), 12));
  });

  // ---- the event stream ----

  function receive(e) {
    events.push(e);
    if (following) advance(1);
    else mark("state");
  }
  function connect() {
    var source = new EventSource("/events");
    source.onmessage = function (m) {
      // The id is the event's index, so an event seen before a reconnect is never applied twice.
      var i = Number(m.lastEventId);
      if (Number.isInteger(i) && i < events.length) return;
      receive(JSON.parse(m.data));
    };
    source.onerror = function () {
      if (events.length === 0) $("state").innerHTML = '<span class="livedot"></span><b>Not connected</b><span class="muted">Start the page with pnpm swarm --serve, then reload.</span>';
    };
  }
  mark("state", "clearing");
  connect();
})();
