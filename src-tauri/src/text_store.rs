//! A tiny `(repo, key) → text` store, shared by the local notes and commit-draft
//! features. Both back a single autosaved text field that survives restarts and
//! is local-only (never synced). They differ solely in table/column names — the
//! save/clear semantics are identical: upsert on save, and delete the row when
//! the value is blank so an emptied field doesn't linger and read as "has content".

use anyhow::Result;

use crate::db::{now_ms, Db};

/// One keyed-text store's table + column names. Every field is a static SQL
/// identifier (never user input), so interpolating them into the query is safe —
/// the values themselves are always bound as parameters.
pub struct Store {
    pub table: &'static str,
    pub key: &'static str,
    pub value: &'static str,
}

impl Store {
    /// The stored text for `key`, or `None` when there's none.
    pub async fn get(&self, db: &Db, repo: &str, key: &str) -> Result<Option<String>> {
        let sql = format!(
            "SELECT {v} FROM {t} WHERE repo = ? AND {k} = ?",
            v = self.value,
            t = self.table,
            k = self.key,
        );
        let row: Option<(String,)> = sqlx::query_as(&sql)
            .bind(repo)
            .bind(key)
            .fetch_optional(db)
            .await?;
        Ok(row.map(|(v,)| v))
    }

    /// Upsert the value, or delete the row when it's blank.
    pub async fn set(&self, db: &Db, repo: &str, key: &str, value: &str) -> Result<()> {
        if value.trim().is_empty() {
            let sql = format!(
                "DELETE FROM {t} WHERE repo = ? AND {k} = ?",
                t = self.table,
                k = self.key
            );
            sqlx::query(&sql).bind(repo).bind(key).execute(db).await?;
            return Ok(());
        }
        let sql = format!(
            "INSERT INTO {t} (repo, {k}, {v}, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(repo, {k}) DO UPDATE SET {v} = excluded.{v}, updated_at = excluded.updated_at",
            t = self.table,
            k = self.key,
            v = self.value,
        );
        sqlx::query(&sql)
            .bind(repo)
            .bind(key)
            .bind(value)
            .bind(now_ms())
            .execute(db)
            .await?;
        Ok(())
    }
}
