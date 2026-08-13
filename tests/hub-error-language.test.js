/* Codex — 2026-08-13: database errors must always become human guidance. */

import test from "node:test";
import assert from "node:assert/strict";

import { humanError as humanDecisionError } from "../hub-decisions.js";
import { translateWorkRepositoryError } from "../hub-work-policy.js";

const DATABASE_LANGUAGE = /\b(?:constraint|violates?|relation|row-level|postgres(?:ql)?|sqlstate|pgrst\d*)\b/i;
const DECISION_IDENTIFIER = /\bdecisions_[a-z0-9_]+\b/i;
const WORK_IDENTIFIER = /\btasks_[a-z0-9_]+\b/i;

function assertPlainSentence(message, identifierPattern, label) {
  assert.equal(typeof message, "string", label);
  assert.ok(message.trim().length > 0, label);
  assert.match(message, /[.!?]$/, label);
  assert.doesNotMatch(message, DATABASE_LANGUAGE, label);
  assert.doesNotMatch(message, identifierPattern, label);
}

test("Decisions drops database language from known and future errors", () => {
  const knownIdentifiers = [
    "decisions_title_length",
    "decisions_decided_state",
    "decisions_status_allowed",
    "decisions_topic_allowed",
    "decisions_counterparty_length",
    "decisions_decided_by_name_length",
    "decisions_lookbook_fk",
    "decisions_workstream_fk",
    "decisions_owner_fk"
  ];
  const errors = knownIdentifiers.map((name) => ({
    label: name,
    raw: { message: `new row for relation "decisions" violates check constraint "${name}"`, code: "23514" }
  }));
  errors.push(
    {
      label: "row-level security",
      raw: { message: 'new row violates row-level security policy for relation "decisions"', code: "42501" }
    },
    {
      label: "duplicate key",
      raw: { message: 'duplicate key value violates unique constraint "decisions_pkey"', code: "23505" }
    },
    {
      label: "unknown future constraint",
      raw: { message: 'new row for relation "decisions" violates check constraint "decisions_decision_present"', code: "23514" }
    },
    {
      label: "unknown schema-cache failure",
      raw: { message: "Could not find decisions_unexpected_column in the relation schema cache", code: "PGRST204" }
    },
    {
      label: "arbitrary internal failure",
      raw: { message: "SECRET_INTERNAL_DIAGNOSTIC_9271" }
    }
  );

  for (const { label, raw } of errors) {
    const message = humanDecisionError(raw);
    assertPlainSentence(message, DECISION_IDENTIFIER, label);
    assert.notEqual(message, raw.message, label);
  }

  assert.equal(
    humanDecisionError(errors.find(({ label }) => label === "unknown future constraint").raw),
    "That could not be saved. Nothing was lost — try again, and tell Salman if it keeps happening."
  );
});

test("Work drops database language from known and future errors", () => {
  const knownIdentifiers = [
    "tasks_title_length",
    "tasks_status_allowed",
    "tasks_priority_allowed",
    "tasks_position_nonnegative",
    "tasks_kind_allowed",
    "tasks_flags_allowed",
    "tasks_source_url_http",
    "tasks_latest_file_url_https",
    "tasks_waiting_has_reason",
    "tasks_review_has_separate_approver",
    "tasks_active_work_fields_present",
    "tasks_done_fields_present",
    "tasks_workstream_fk",
    "tasks_owner_fk",
    "tasks_approver_fk",
    "tasks_source_design_fk",
    "tasks_source_idea_fk"
  ];
  const errors = knownIdentifiers.map((name) => ({
    label: name,
    raw: {
      serverMessage: `new row for relation "tasks" violates check constraint "${name}"`,
      code: name.endsWith("_fk") ? "23503" : "23514"
    }
  }));
  errors.push(
    {
      label: "row-level security",
      raw: { serverMessage: 'permission denied by row-level security for relation "tasks"', code: "42501" }
    },
    {
      label: "Doing uniqueness",
      raw: {
        serverMessage: 'duplicate key value violates unique constraint "tasks_one_doing_per_owner_active_uidx"',
        code: "23505"
      }
    },
    {
      label: "unknown future constraint",
      raw: {
        serverMessage: 'new row for relation "tasks" violates check constraint "tasks_future_factory_rule"',
        code: "23514"
      }
    },
    {
      label: "unknown database failure",
      raw: { serverMessage: 'SQLSTATE XX999: postgres relation tasks failed in tasks_unpredicted_guard', code: "XX999" }
    }
  );

  for (const { label, raw } of errors) {
    const translated = translateWorkRepositoryError(raw, {});
    assertPlainSentence(translated.message, WORK_IDENTIFIER, label);
    assert.notEqual(translated.message, raw.serverMessage, label);
  }

  assert.equal(
    translateWorkRepositoryError(errors.find(({ label }) => label === "unknown future constraint").raw, {}).message,
    "This older item does not meet a current Hub rule. Ask a workspace admin or owner to repair it."
  );
  assert.equal(
    translateWorkRepositoryError(errors.find(({ label }) => label === "unknown database failure").raw, {}).message,
    "The Hub could not save this change. Check your connection, then refresh and try again."
  );
});
