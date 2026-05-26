/**
 * Initial schema. Forward-only — never edit a deployed migration.
 * Per CLAUDE.md §6: add nullable → backfill → constrain → drop pattern for
 * later schema changes.
 */
export const up = (pgm) => {
    pgm.createExtension('uuid-ossp', { ifNotExists: true });
    pgm.createExtension('pgcrypto', { ifNotExists: true });

    pgm.createTable('tenant', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
        name: { type: 'text', notNull: true },
        plan: { type: 'text', notNull: true, default: 'free' },
        stripe_customer_id: { type: 'text' },
        stripe_subscription_id: { type: 'text' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    });

    pgm.createTable('app_user', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
        tenant_id: {
            type: 'uuid', notNull: true,
            references: 'tenant', onDelete: 'CASCADE',
        },
        email: { type: 'text', notNull: true, unique: true },
        role: { type: 'text', notNull: true, default: 'member' },
        // Customer-supplied git host tokens, KMS-encrypted in prod. In dev
        // they're stored as-is with a clear DO-NOT-LOG annotation.
        github_token_enc: { type: 'text' },
        gitlab_token_enc: { type: 'text' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    });
    pgm.createIndex('app_user', 'tenant_id');

    pgm.createTable('mr_review', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
        tenant_id: {
            type: 'uuid', notNull: true,
            references: 'tenant', onDelete: 'CASCADE',
        },
        job_id: { type: 'text', notNull: true, unique: true },
        platform: { type: 'text', notNull: true },          // github | gitlab
        repo_full_name: { type: 'text', notNull: true },
        mr_iid: { type: 'integer', notNull: true },
        head_sha: { type: 'text', notNull: true },
        target_sha: { type: 'text' },
        status: { type: 'text', notNull: true, default: 'queued' }, // queued|running|done|failed
        verdict: { type: 'text' },
        report: { type: 'jsonb' },                          // full VerdictReport
        error: { type: 'text' },
        cache_hits: { type: 'integer', notNull: true, default: 0 },
        tokens_in: { type: 'integer', notNull: true, default: 0 },
        tokens_out: { type: 'integer', notNull: true, default: 0 },
        cost_cents: { type: 'integer', notNull: true, default: 0 },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
        completed_at: { type: 'timestamptz' },
    });
    pgm.createIndex('mr_review', ['tenant_id', 'platform', 'repo_full_name', 'mr_iid']);
    pgm.createIndex('mr_review', 'head_sha');

    pgm.createTable('standards_bundle', {
        tenant_id: {
            type: 'uuid', notNull: true, primaryKey: true,
            references: 'tenant', onDelete: 'CASCADE',
        },
        version: { type: 'integer', notNull: true, default: 1 },
        contents: { type: 'jsonb', notNull: true, default: '{}' },
        updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    });

    pgm.createTable('finding_feedback', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
        mr_review_id: {
            type: 'uuid', notNull: true,
            references: 'mr_review', onDelete: 'CASCADE',
        },
        finding_id: { type: 'text', notNull: true },
        action: { type: 'text', notNull: true },            // accept|dismiss|edit
        reason: { type: 'text' },
        user_id: { type: 'uuid', references: 'app_user' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    });
    pgm.createIndex('finding_feedback', 'mr_review_id');

    pgm.createTable('usage_event', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
        tenant_id: {
            type: 'uuid', notNull: true,
            references: 'tenant', onDelete: 'CASCADE',
        },
        kind: { type: 'text', notNull: true },              // mr_review | webhook | api_call
        tokens_in: { type: 'integer', notNull: true, default: 0 },
        tokens_out: { type: 'integer', notNull: true, default: 0 },
        cost_cents: { type: 'integer', notNull: true, default: 0 },
        stripe_reported: { type: 'boolean', notNull: true, default: false },
        metadata: { type: 'jsonb' },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    });
    pgm.createIndex('usage_event', ['tenant_id', 'created_at']);
    pgm.createIndex('usage_event', ['stripe_reported', 'created_at']);

    pgm.createTable('webhook_install', {
        id: { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
        tenant_id: {
            type: 'uuid', notNull: true,
            references: 'tenant', onDelete: 'CASCADE',
        },
        platform: { type: 'text', notNull: true },          // github | gitlab
        installation_id: { type: 'text', notNull: true },
        account_login: { type: 'text', notNull: true },
        created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    });
    pgm.addConstraint('webhook_install', 'webhook_install_unique', {
        unique: ['platform', 'installation_id'],
    });
};

export const down = (pgm) => {
    pgm.dropTable('webhook_install');
    pgm.dropTable('usage_event');
    pgm.dropTable('finding_feedback');
    pgm.dropTable('standards_bundle');
    pgm.dropTable('mr_review');
    pgm.dropTable('app_user');
    pgm.dropTable('tenant');
};
