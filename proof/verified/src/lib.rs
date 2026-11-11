//! elevate's policy kernel, proved with Verus.
//!
//! A model of `packages/policy/src` (gates, lifecycle, write guard). Each
//! `ensures` clause and lemma is one requirement from ../intent.md, tagged
//! with its id (L1, S3, T7, W2, ...) so the mutation check can tell which
//! requirement caught a planted bug. Everything inside `verus!` is checked;
//! the `extern "C"` shim at the bottom is outside it and is trusted (TB1).

use vstd::prelude::*;

verus! {

// ═══ Gate 1: is the new thing actually legit? ════════════════════════════

pub open spec fn combined(prior: int, review: int) -> int {
    (2 * prior + 3 * review) / 5
}

pub open spec fn gate1_passes(prior: int, review: int, legit: bool, threshold: int, floor: int) -> bool {
    legit && prior >= floor && combined(prior, review) >= threshold
}

pub struct Gate1 {
    pub passed: bool,
    pub score: u32,
}

pub fn legitimacy_decision(prior: u32, review: u32, legit: bool, threshold: u32, prior_floor: u32) -> (g: Gate1)
    requires
        prior <= 100,
        review <= 100,
        threshold <= 100,
        prior_floor <= 100,
    ensures
        // L1. The score is (2·prior + 3·review) / 5, rounded down.
        g.score as int == combined(prior as int, review as int), // L1
        // L2. The score stays within 0..100.
        g.score <= 100, // L2
        // L4. The reviewer's "not legit" is a veto.
        !legit ==> !g.passed, // L4
        // L5. Without independent evidence above the floor, nothing passes.
        prior < prior_floor ==> !g.passed, // L5
        // L6. Otherwise it passes exactly when the score reaches the threshold.
        g.passed == gate1_passes(prior as int, review as int, legit, threshold as int, prior_floor as int), // L6
{
    let score = (2 * prior + 3 * review) / 5;
    let passed = legit && prior >= prior_floor && score >= threshold;
    Gate1 { passed, score }
}

/// L3. More evidence never hurts: raising the prior or the review never
/// lowers the score, and never turns a pass into a fail.
pub proof fn lemma_more_evidence_never_hurts(p1: int, r1: int, p2: int, r2: int, legit: bool, t: int, f: int)
    requires
        0 <= p1 <= p2,
        0 <= r1 <= r2,
    ensures
        combined(p1, r1) <= combined(p2, r2), // L3
        gate1_passes(p1, r1, legit, t, f) ==> gate1_passes(p2, r2, legit, t, f), // L3
{
    vstd::arithmetic::div_mod::lemma_div_is_ordered(2 * p1 + 3 * r1, 2 * p2 + 3 * r2, 5);
}

// ═══ Gate 2: is the improvement sound, and will it make a difference? ═══

pub enum Risk {
    Low,
    Medium,
    High,
}

pub open spec fn margin(r: Risk) -> int {
    match r {
        Risk::Low => 0,
        Risk::Medium => 5,
        Risk::High => 15,
    }
}

pub open spec fn bar(threshold: int, r: Risk) -> int {
    if threshold + margin(r) > 100 { 100 } else { threshold + margin(r) }
}

pub open spec fn gate2_passes(gate1: bool, sound: bool, measurable: bool, score: int, risk: Risk, threshold: int) -> bool {
    gate1 && sound && measurable && score >= bar(threshold, risk)
}

pub fn soundness_decision(gate1_passed: bool, sound: bool, measurable: bool, score: u32, risk: Risk, threshold: u32) -> (passed: bool)
    requires
        score <= 100,
        threshold <= 100,
    ensures
        // S1. Nothing is sound for a technique that failed Gate 1.
        !gate1_passed ==> !passed, // S1
        // S2. The reviewer's "unsound" is a veto.
        !sound ==> !passed, // S2
        // S3. No stated way to measure the impact, no pass.
        !measurable ==> !passed, // S3
        // S5. Otherwise it passes exactly when the score reaches the risk-adjusted bar.
        passed == gate2_passes(gate1_passed, sound, measurable, score as int, risk, threshold as int), // S5
{
    let m: u32 = match risk {
        Risk::Low => 0,
        Risk::Medium => 5,
        Risk::High => 15,
    };
    let required = if threshold + m > 100 { 100 } else { threshold + m };
    gate1_passed && sound && measurable && score >= required
}

/// S4. Riskier changes need a stronger case: the bar never falls as risk
/// rises, so a pass at high risk is a pass at medium, and medium at low.
pub proof fn lemma_riskier_needs_more(t: int)
    requires
        0 <= t <= 100,
    ensures
        bar(t, Risk::Low) <= bar(t, Risk::Medium) && bar(t, Risk::Medium) <= bar(t, Risk::High), // S4
        bar(t, Risk::Low) == t && bar(t, Risk::High) >= t, // S4
{
}

pub open spec fn rank(relevance: int, legitimacy: int, soundness: int) -> int {
    (30 * relevance + 30 * legitimacy + 40 * soundness) / 100
}

pub fn recommendation_score(relevance: u32, legitimacy: u32, soundness: u32) -> (s: u32)
    requires
        relevance <= 100,
        legitimacy <= 100,
        soundness <= 100,
    ensures
        // S6. The inbox rank is (30·relevance + 30·legitimacy + 40·soundness) / 100, within 0..100.
        s as int == rank(relevance as int, legitimacy as int, soundness as int) && s <= 100, // S6
{
    (30 * relevance + 30 * legitimacy + 40 * soundness) / 100
}

/// S6. The rank never drops when any input rises.
pub proof fn lemma_rank_monotone(a1: int, b1: int, c1: int, a2: int, b2: int, c2: int)
    requires
        0 <= a1 <= a2,
        0 <= b1 <= b2,
        0 <= c1 <= c2,
    ensures
        rank(a1, b1, c1) <= rank(a2, b2, c2), // S6
{
    vstd::arithmetic::div_mod::lemma_div_is_ordered(30 * a1 + 30 * b1 + 40 * c1, 30 * a2 + 30 * b2 + 40 * c2, 100);
}

// ═══ The lifecycle: a swarm only after both gates and your approval ═════

#[derive(Clone, Copy)]
pub enum Status {
    Candidate,
    GatedOut,
    Open,
    Approved,
    Rejected,
    InProgress,
    PrOpened,
    Failed,
}

#[derive(Clone, Copy)]
pub enum Event {
    GatePass,
    GateFail,
    Approve,
    Reject,
    Start,
    Pr,
    Fail,
    Retry,
    Regate,
    Reopen,
}

/// Past your approval: approved, running, or finished either way.
pub open spec fn cleared(s: Status) -> bool {
    s == Status::Approved || s == Status::InProgress || s == Status::PrOpened || s == Status::Failed
}

pub fn transition(s: Status, e: Event) -> (r: Option<Status>)
    ensures
        // T1. Only an open recommendation is approved; or a failed run you approved before is retried.
        r == Some(Status::Approved) ==> (s == Status::Open && e == Event::Approve) || (s == Status::Failed && e == Event::Retry), // T1
        // T2. A swarm starts only from approved.
        r == Some(Status::InProgress) ==> s == Status::Approved && e == Event::Start, // T2
        // T2. A PR or a failure only comes from a running swarm.
        (r == Some(Status::PrOpened) || r == Some(Status::Failed)) ==> s == Status::InProgress, // T2
        // T3. Nothing reaches the inbox without passing the gates.
        r == Some(Status::Open) ==> s == Status::Candidate && e == Event::GatePass, // T3
        // T4. Gated out can only go back to candidate, to be checked again.
        s == Status::GatedOut ==> (r == None::<Status> || r == Some(Status::Candidate)), // T4
        // T5. A draft PR is the end.
        s == Status::PrOpened ==> r == None::<Status>, // T5
        // T6. A rejected recommendation reopens as a candidate, to be re-gated.
        s == Status::Rejected && e == Event::Reopen ==> r == Some(Status::Candidate), // T6
{
    match s {
        Status::Candidate => match e {
            Event::GatePass => Some(Status::Open),
            Event::GateFail => Some(Status::GatedOut),
            _ => None,
        },
        Status::GatedOut => match e {
            Event::Regate => Some(Status::Candidate),
            _ => None,
        },
        Status::Open => match e {
            Event::Approve => Some(Status::Approved),
            Event::Reject => Some(Status::Rejected),
            Event::Regate => Some(Status::Candidate),
            _ => None,
        },
        Status::Approved => match e {
            Event::Start => Some(Status::InProgress),
            Event::Reject => Some(Status::Rejected),
            _ => None,
        },
        Status::InProgress => match e {
            Event::Pr => Some(Status::PrOpened),
            Event::Fail => Some(Status::Failed),
            _ => None,
        },
        Status::Failed => match e {
            Event::Retry => Some(Status::Approved),
            Event::Reject => Some(Status::Rejected),
            _ => None,
        },
        Status::Rejected => match e {
            Event::Reopen => Some(Status::Candidate),
            _ => None,
        },
        Status::PrOpened => None,
    }
}

pub open spec fn ends_cleared(r: Option<Status>) -> bool {
    match r {
        Some(x) => cleared(x),
        None => false,
    }
}

/// Replays a recommendation's history from `candidate`; None if any event is
/// not allowed where it occurs. The app replays the audit trail before it
/// starts a swarm.
pub fn replay(events: &Vec<Event>) -> (r: Option<Status>)
    ensures
        // T7. No swarm without both gates and your approval: a history that ends approved, running or finished passed the gates, then was approved.
        ends_cleared(r) ==> exists|i: int, j: int| 0 <= i < j < events.len() && events[i] == Event::GatePass && events[j] == Event::Approve, // T7
{
    let mut cur = Status::Candidate;
    let ghost mut gp: int = -1;
    let ghost mut ap: int = -1;
    let mut k: usize = 0;
    while k < events.len()
        invariant
            k <= events.len(),
            (cur == Status::Open || cleared(cur)) ==> 0 <= gp < k && events[gp] == Event::GatePass, // T7
            cleared(cur) ==> gp < ap < k && events[ap] == Event::Approve, // T7
        decreases events.len() - k,
    {
        let e = events[k];
        match transition(cur, e) {
            Some(next) => {
                proof {
                    if next == Status::Open {
                        gp = k as int;
                    }
                    if next == Status::Approved && cur == Status::Open {
                        ap = k as int;
                    }
                }
                cur = next;
            },
            None => {
                return None;
            },
        }
        k = k + 1;
    }
    Some(cur)
}

// ═══ The write guard: nothing touches a repo without your approval ══════

pub enum Action {
    CreateIssue,
    Comment,
    AssignAgent,
    RunLocalAgent,
    PushBranch,
    OpenPr,
    ClosePr,
    MergePr,
    PushDefaultBranch,
    ForcePush,
}

pub enum Verdict {
    Allow,
    Forbidden,
    NotApproved,
    RepoNotAllowed,
    WrongRepo,
    NotDraft,
    BudgetExhausted,
}

pub struct WriteRequest {
    pub action: Action,
    pub status: Status,
    pub allow_swarm: bool,
    pub same_repo: bool,
    pub draft: bool,
    pub tasks_used: u32,
    pub max_tasks: u32,
    pub minutes_used: u32,
    pub max_minutes: u32,
    pub turns_used: u32,
    pub max_turns: u32,
}

pub open spec fn forbidden(a: Action) -> bool {
    a == Action::MergePr || a == Action::PushDefaultBranch || a == Action::ForcePush
}

pub open spec fn spends(a: Action) -> bool {
    a == Action::AssignAgent || a == Action::RunLocalAgent
}

pub open spec fn approved(s: Status) -> bool {
    s == Status::Approved || s == Status::InProgress
}

pub open spec fn within_budget(q: WriteRequest) -> bool {
    q.tasks_used < q.max_tasks && q.minutes_used < q.max_minutes && q.turns_used < q.max_turns
}

pub open spec fn may_write(q: WriteRequest) -> bool {
    !forbidden(q.action) && approved(q.status) && q.allow_swarm && q.same_repo
        && (q.action == Action::OpenPr ==> q.draft) && (spends(q.action) ==> within_budget(q))
}

pub fn authorize_write(q: &WriteRequest) -> (v: Verdict)
    ensures
        // W1. Never merge, push to the default branch, or force-push.
        forbidden(q.action) ==> v == Verdict::Forbidden, // W1
        // W2. No write until you approve.
        !approved(q.status) ==> v != Verdict::Allow, // W2
        // W3. Only repos you opted in.
        !q.allow_swarm ==> v != Verdict::Allow, // W3
        // W4. Only the recommendation's own repo.
        !q.same_repo ==> v != Verdict::Allow, // W4
        // W5. Pull requests are drafts.
        q.action == Action::OpenPr && !q.draft ==> v != Verdict::Allow, // W5
        // W6. Agent work stops at the budget.
        spends(q.action) && !within_budget(*q) ==> v != Verdict::Allow, // W6
        // W7. Otherwise the write is allowed, and only then.
        (v == Verdict::Allow) == may_write(*q), // W7
{
    match q.action {
        Action::MergePr | Action::PushDefaultBranch | Action::ForcePush => {
            return Verdict::Forbidden;
        },
        _ => {},
    }
    match q.status {
        Status::Approved | Status::InProgress => {},
        _ => {
            return Verdict::NotApproved;
        },
    }
    if !q.allow_swarm {
        return Verdict::RepoNotAllowed;
    }
    if !q.same_repo {
        return Verdict::WrongRepo;
    }
    match q.action {
        Action::OpenPr => {
            if !q.draft {
                return Verdict::NotDraft;
            }
        },
        _ => {},
    }
    match q.action {
        Action::AssignAgent | Action::RunLocalAgent => {
            if q.tasks_used >= q.max_tasks || q.minutes_used >= q.max_minutes || q.turns_used >= q.max_turns {
                return Verdict::BudgetExhausted;
            }
        },
        _ => {},
    }
    Verdict::Allow
}

} // verus!

// ═══ The trusted shim (TB1, not verified): the WASM exports ═════════════
//
// Codes mirror the order of each enum's variants. Out-of-range codes map to
// the last variant for statuses/events/actions only where the TypeScript
// adapter never produces them; scores above 100 are clamped.

fn pct(x: u32) -> u32 {
    if x > 100 { 100 } else { x }
}

fn status_of(c: u32) -> Status {
    match c {
        0 => Status::Candidate,
        1 => Status::GatedOut,
        2 => Status::Open,
        3 => Status::Approved,
        4 => Status::Rejected,
        5 => Status::InProgress,
        6 => Status::PrOpened,
        _ => Status::Failed,
    }
}

fn status_code(s: Status) -> u32 {
    match s {
        Status::Candidate => 0,
        Status::GatedOut => 1,
        Status::Open => 2,
        Status::Approved => 3,
        Status::Rejected => 4,
        Status::InProgress => 5,
        Status::PrOpened => 6,
        Status::Failed => 7,
    }
}

fn event_of(c: u32) -> Event {
    match c {
        0 => Event::GatePass,
        1 => Event::GateFail,
        2 => Event::Approve,
        3 => Event::Reject,
        4 => Event::Start,
        5 => Event::Pr,
        6 => Event::Fail,
        7 => Event::Retry,
        8 => Event::Regate,
        _ => Event::Reopen,
    }
}

/// Result: score * 2 + passed.
#[no_mangle]
pub extern "C" fn legitimacy_code(prior: u32, review: u32, legit: u32, threshold: u32, floor: u32) -> u32 {
    let g = legitimacy_decision(pct(prior), pct(review), legit != 0, pct(threshold), pct(floor));
    g.score * 2 + if g.passed { 1 } else { 0 }
}

/// Risk 0 low, 1 medium, anything else high. Result 0 or 1.
#[no_mangle]
pub extern "C" fn soundness_code(gate1: u32, sound: u32, measurable: u32, score: u32, risk: u32, threshold: u32) -> u32 {
    let risk = match risk {
        0 => Risk::Low,
        1 => Risk::Medium,
        _ => Risk::High,
    };
    soundness_decision(gate1 != 0, sound != 0, measurable != 0, pct(score), risk, pct(threshold)) as u32
}

#[no_mangle]
pub extern "C" fn score_code(relevance: u32, legitimacy: u32, soundness: u32) -> u32 {
    recommendation_score(pct(relevance), pct(legitimacy), pct(soundness))
}

/// Result: 0 none, else status code + 1.
#[no_mangle]
pub extern "C" fn transition_code(status: u32, event: u32) -> u32 {
    match transition(status_of(status), event_of(event)) {
        None => 0,
        Some(s) => status_code(s) + 1,
    }
}

/// Up to 15 events packed 4 bits each (first event lowest), length in the
/// top 4 bits. Result: 0 none, else status code + 1.
#[no_mangle]
pub extern "C" fn replay_code(packed: u64) -> u32 {
    let len = (packed >> 60) as usize;
    let mut events = Vec::new();
    for i in 0..len {
        events.push(event_of(((packed >> (4 * i)) & 0xF) as u32));
    }
    match replay(&events) {
        None => 0,
        Some(s) => status_code(s) + 1,
    }
}

/// Action codes follow the enum; anything above 9 is force_push. Result is
/// the verdict code (0 allow ... 6 budget exhausted).
#[no_mangle]
pub extern "C" fn authorize_code(
    action: u32,
    status: u32,
    allow_swarm: u32,
    same_repo: u32,
    draft: u32,
    tasks_used: u32,
    max_tasks: u32,
    minutes_used: u32,
    max_minutes: u32,
    turns_used: u32,
    max_turns: u32,
) -> u32 {
    let action = match action {
        0 => Action::CreateIssue,
        1 => Action::Comment,
        2 => Action::AssignAgent,
        3 => Action::RunLocalAgent,
        4 => Action::PushBranch,
        5 => Action::OpenPr,
        6 => Action::ClosePr,
        7 => Action::MergePr,
        8 => Action::PushDefaultBranch,
        _ => Action::ForcePush,
    };
    let q = WriteRequest {
        action,
        status: status_of(status),
        allow_swarm: allow_swarm != 0,
        same_repo: same_repo != 0,
        draft: draft != 0,
        tasks_used,
        max_tasks,
        minutes_used,
        max_minutes,
        turns_used,
        max_turns,
    };
    match authorize_write(&q) {
        Verdict::Allow => 0,
        Verdict::Forbidden => 1,
        Verdict::NotApproved => 2,
        Verdict::RepoNotAllowed => 3,
        Verdict::WrongRepo => 4,
        Verdict::NotDraft => 5,
        Verdict::BudgetExhausted => 6,
    }
}
