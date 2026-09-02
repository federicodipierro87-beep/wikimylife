import type { $Enums } from "@prisma/client";
import type {
  CardStatus,
  Outcome,
  PrereqType,
  RecordingStatus,
  RefType,
  Scope,
  Severity,
  Visibility,
} from "@wikimylife/shared";

/**
 * Ponte a compile time fra gli enum di `@wikimylife/shared` e quelli generati
 * da Prisma.
 *
 * `shared` non puo' importare `@prisma/client` (deve restare isomorfo e
 * importabile da React Native), quindi i due elenchi sono scritti due volte.
 * Due elenchi scritti a mano divergono: e' una questione di quando, non di se.
 *
 * Questo file fa fallire `tsc` nel momento esatto in cui divergono — un valore
 * aggiunto a uno solo dei due lati, o rimosso da uno solo. Non emette una
 * singola riga di JavaScript: sono solo alias di tipo.
 */

/** `true` solo se A e B sono mutuamente assegnabili, cioe' la stessa union. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Se l'argomento non e' `true`, il vincolo non e' soddisfatto e la build muore. */
type AssertTrue<T extends true> = T;

export type ScopeParity = AssertTrue<Exact<Scope, $Enums.Scope>>;
export type VisibilityParity = AssertTrue<Exact<Visibility, $Enums.Visibility>>;
export type CardStatusParity = AssertTrue<Exact<CardStatus, $Enums.CardStatus>>;
export type RecordingStatusParity = AssertTrue<Exact<RecordingStatus, $Enums.RecordingStatus>>;
export type PrereqTypeParity = AssertTrue<Exact<PrereqType, $Enums.PrereqType>>;
export type SeverityParity = AssertTrue<Exact<Severity, $Enums.Severity>>;
export type RefTypeParity = AssertTrue<Exact<RefType, $Enums.RefType>>;
export type OutcomeParity = AssertTrue<Exact<Outcome, $Enums.Outcome>>;

/**
 * [D2] La prova che i due cicli di vita sono davvero disgiunti.
 *
 * Non e' pedanteria: `CardStatus` e `RecordingStatus` condividono tre valori su
 * quattro, e senza questa riga niente impedirebbe a qualcuno di "semplificare"
 * riducendoli a un enum solo — riaprendo esattamente l'ambiguita' che la
 * deviazione D2 chiude.
 */
export type StatusEnumsAreDisjointTypes = AssertTrue<
  Exact<Exact<CardStatus, RecordingStatus>, false>
>;
