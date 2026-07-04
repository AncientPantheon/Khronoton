# Khronoton

> *The heartbeat. An instrument that emits the ticks of time.*

A **scheduler and trigger primitive** — fires actions on time-based
intervals or event-based triggers. Every Automaton's sense of *when*;
also usable standalone by any service that needs disciplined
scheduling without the rest of the agent stack.

## Role in the Pantheon architecture

Khronoton is one of the **three Constructors** — the chain-agnostic
primitives every entity in the ecosystem composes:

| Constructor | Question it answers | This repo |
| ----------- | ------------------- | --------- |
| **Pythia**  | What is the state of the world? | [AncientPantheon/Pythia](https://github.com/AncientPantheon/Pythia) |
| **Codex**   | Who am I, and how do I sign?    | [AncientPantheon/Codex](https://github.com/AncientPantheon/Codex) |
| **Khronoton** | When do I act?                | ✅ |

In the entity taxonomy, Khronoton is precisely what separates an
**Automaton** from a **Daimon**: an Automaton's actions are triggered
by Khronoton (autonomous, on rails); a Daimon's actions are triggered
by a human. Same composition otherwise.

## Provenance — migrated from the AncientHoldings hub

The hub's existing inline scheduler ("Cronoton") fires StoicPower
mints, pool payments, and other operator jobs today. This repo is its
extraction and generalisation: the schedule-firing API surface becomes
`@ancientpantheon/khronoton-core`; hub-specific glue (persistence,
admin UI) stays in the hub, which imports this package for the actual
scheduling logic.

## Planned packages

| Package | Purpose |
| ------- | ------- |
| `@ancientpantheon/khronoton-core` | Interval + event-trigger scheduling, staleness caps, tick auditing |

## Status

**Scaffold.** Migration from the AncientHoldings hub's inline
scheduler is Phase 4 of the AncientPantheon kickstart plan.

## License

Proprietary — **all rights reserved**. See [LICENSE](LICENSE). No rights
are granted to any third party; the software is for the exclusive use of
AncientHoldings (ancientholdings.eu). Not open source.
