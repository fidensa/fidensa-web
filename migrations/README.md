# Migration contract

This directory reserves the website-owned database migration boundary for Phase 02 and later work. It intentionally contains no SQL or production schema.

When an approved task adds migrations:

1. Name each immutable file `YYYYMMDDHHMMSS_short_description.sql` in UTC order.
2. Keep application, verification, privacy, subscription, suppression, communication, scoring, rights, and abuse-control lifecycles separated.
3. Use private schemas, least privilege, explicit grants/revocations, and transaction-safe forward changes as required by the accepted architecture.
4. Record an explicit recovery migration or operator recovery procedure; never edit an applied migration.
5. Test role behavior and migration ordering against disposable state before any provider-side action.

Provider provisioning, credentials, production identifiers, and account mutations remain outside this directory and outside Phase 01.
