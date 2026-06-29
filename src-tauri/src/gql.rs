//! Shared GraphQL plumbing for the Linear and GitHub clients: the
//! `{ nodes: [...] }` connection wrapper, the response envelope, and the
//! POST → decode → error-check helper. Each client keeps its own request wiring
//! (URL, auth, headers); only the shape of the response is shared.

use anyhow::{anyhow, bail, Context, Result};
use serde::de::DeserializeOwned;
use serde::Deserialize;

/// A GraphQL `{ nodes: [...] }` connection. One generic wrapper instead of a
/// near-identical `*Conn` struct per query. `Default` is hand-written because the
/// derive would needlessly require `T: Default` — an absent connection is simply
/// no nodes.
#[derive(Deserialize)]
pub struct Connection<T> {
    #[serde(default = "Vec::new")]
    pub nodes: Vec<T>,
}
impl<T> Default for Connection<T> {
    fn default() -> Self {
        Self { nodes: Vec::new() }
    }
}

/// A single GraphQL error from the `errors` array.
#[derive(Deserialize)]
struct GqlError {
    message: String,
}

#[derive(Deserialize)]
struct Envelope<T> {
    data: Option<T>,
    /// A GraphQL endpoint can return HTTP 200 with `data: null` + a populated
    /// `errors` array on permission/validation failures — surfaced rather than
    /// reported as an empty response.
    #[serde(default)]
    errors: Vec<GqlError>,
}

/// Send a prepared GraphQL POST and decode its typed `data` payload, turning a
/// populated `errors` array (even on HTTP 200) into an error. `service` names the
/// backend for the error messages (e.g. "Linear", "GitHub"). The caller builds
/// the request (URL, auth, headers, JSON body) so each client keeps its wiring.
pub async fn post<T: DeserializeOwned>(req: reqwest::RequestBuilder, service: &str) -> Result<T> {
    let res = req
        .send()
        .await
        .with_context(|| format!("{service} GraphQL request"))?;
    if !res.status().is_success() {
        bail!("{service} GraphQL returned {}", res.status());
    }
    let env: Envelope<T> = res
        .json()
        .await
        .with_context(|| format!("decoding {service} response"))?;
    if !env.errors.is_empty() {
        let joined = env
            .errors
            .iter()
            .map(|e| e.message.as_str())
            .collect::<Vec<_>>()
            .join("; ");
        bail!("{service}: {joined}");
    }
    env.data.ok_or_else(|| anyhow!("empty {service} response"))
}
