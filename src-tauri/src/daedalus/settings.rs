//! This Mac's own settings — keeping it awake, Claude Remote Control, santree
//! on the box — read and asked for through the Daedalus agent's own socket
//! (docs/remote.md, "This Mac's settings"; the client is `santree-remote-client`'s
//! `AgentControl`).
//!
//! The box decides them, so santree only asks: a change shows as pending until
//! the box's policy carries it, or as failed with the agent's reason. santree
//! ON is never sent anywhere: it grants a shell on the box, so the agent names
//! the Daedalus page where an admin confirms it, and santree opens that page
//! in the browser. Every answer here is a value — an agent that isn't there,
//! is too old, or refuses is a state the card shows, never a toast.

use anyhow::{bail, Result};

use santree_core::domain::{
    DaedalusMachine, DaedalusMachineSettings, DaedalusSettingAnswer, DaedalusSettingFailed,
    DaedalusSettingKey, DaedalusSettingPending, DaedalusSettingVia,
};
use santree_remote_client::control::{SettingKey, SettingVia};
use santree_remote_client::{AgentControl, ControlError, MachineSettings, SetOutcome};

/// This Mac's settings, or why they can't be read.
pub async fn read(control: &AgentControl) -> DaedalusMachine {
    match control.settings().await {
        Ok(settings) => DaedalusMachine::Ready {
            settings: machine(settings),
        },
        Err(ControlError::NoAgent) => DaedalusMachine::AgentMissing,
        Err(ControlError::Outdated) => DaedalusMachine::AgentOutdated,
        Err(e) => DaedalusMachine::Unavailable {
            reason: e.to_string(),
        },
    }
}

/// Ask the box for `key` = `value`. santree ON answers the page to confirm it
/// on, which `open` opens — an `https` page only, whatever the agent names.
pub async fn set(
    control: &AgentControl,
    key: DaedalusSettingKey,
    value: bool,
    open: impl FnOnce(&str) -> Result<()>,
) -> DaedalusSettingAnswer {
    match control.set(wire_key(key), value).await {
        Ok(SetOutcome::Sent) => DaedalusSettingAnswer::Sent,
        Ok(SetOutcome::Unchanged) => DaedalusSettingAnswer::Unchanged,
        Ok(SetOutcome::Confirm(url)) => match web_page(&url).and_then(|()| open(&url)) {
            Ok(()) => DaedalusSettingAnswer::Opened { url },
            Err(e) => DaedalusSettingAnswer::Refused {
                reason: format!("santree couldn't open Daedalus's page to confirm it: {e:#}"),
            },
        },
        Err(ControlError::Outdated) => DaedalusSettingAnswer::AgentOutdated,
        Err(e) => DaedalusSettingAnswer::Refused {
            reason: e.to_string(),
        },
    }
}

/// The confirm page must be a web page: an `https` URL with a host and no
/// credentials, checked by parse (never by prefix) before the OS opens it.
fn web_page(url: &str) -> Result<()> {
    let parsed = reqwest::Url::parse(url)?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none_or(str::is_empty)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        bail!("the Daedalus agent named a page that isn't an https address: {url}");
    }
    Ok(())
}

fn wire_key(key: DaedalusSettingKey) -> SettingKey {
    match key {
        DaedalusSettingKey::AwakeHold => SettingKey::AwakeHold,
        DaedalusSettingKey::ClaudeRemoteControl => SettingKey::ClaudeRemoteControl,
        DaedalusSettingKey::Santree => SettingKey::Santree,
    }
}

fn domain_key(key: SettingKey) -> DaedalusSettingKey {
    match key {
        SettingKey::AwakeHold => DaedalusSettingKey::AwakeHold,
        SettingKey::ClaudeRemoteControl => DaedalusSettingKey::ClaudeRemoteControl,
        SettingKey::Santree => DaedalusSettingKey::Santree,
    }
}

fn machine(s: MachineSettings) -> DaedalusMachineSettings {
    DaedalusMachineSettings {
        fingerprint: s.fingerprint,
        fingerprint_short: s.fingerprint_short,
        linked: s.linked,
        awake_hold: s.awake_hold,
        claude_remote_control: s.claude_remote_control,
        santree: s.santree,
        pending: s
            .pending
            .into_iter()
            .map(|p| DaedalusSettingPending {
                key: domain_key(p.key),
                want: p.want,
                via: match p.via {
                    SettingVia::Box => DaedalusSettingVia::Box,
                    SettingVia::Browser => DaedalusSettingVia::Browser,
                },
            })
            .collect(),
        failed: s
            .failed
            .into_iter()
            .map(|f| DaedalusSettingFailed {
                key: domain_key(f.key),
                want: f.want,
                why: f.why,
            })
            .collect(),
        operator: s.operator,
        // An agent that doesn't say is one this user can't be shown as able to.
        may_change: s.may_change.unwrap_or(false),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use santree_remote_client::fake::FakeAgentControl;

    use super::*;

    fn kept() -> MachineSettings {
        MachineSettings {
            node: Some("0123456789abcdef".into()),
            fingerprint: Some("f876:e2c7:1a0b:2c3d:8029".into()),
            fingerprint_short: Some("f876:e2c7…8029".into()),
            linked: true,
            awake_hold: true,
            claude_remote_control: true,
            santree: false,
            operator: Some("santiago".into()),
            ..MachineSettings::default()
        }
    }

    /// The pages opened, oldest first.
    type Opened = Arc<Mutex<Vec<String>>>;

    fn opened() -> (Opened, impl Fn(&str) -> Result<()> + Clone) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let sink = log.clone();
        (log, move |url: &str| {
            sink.lock().unwrap().push(url.to_string());
            Ok(())
        })
    }

    /// The card's whole loop against a fake `agent.sock`: read, ask, the box
    /// applying it, santree ON opening its page, and the refusals as values.
    #[tokio::test]
    async fn settings_are_read_and_asked_for_through_the_agent() {
        let dir = tempfile::tempdir().unwrap();
        let agent = FakeAgentControl::serve(dir.path().join("agent.sock"), kept()).unwrap();
        let control = agent.control();

        let DaedalusMachine::Ready { settings } = read(&control).await else {
            panic!("expected settings");
        };
        assert!(settings.may_change && settings.linked && settings.awake_hold);
        assert_eq!(
            settings.fingerprint_short.as_deref(),
            Some("f876:e2c7…8029")
        );
        assert_eq!(settings.operator.as_deref(), Some("santiago"));

        let (log, open) = opened();
        assert_eq!(
            set(&control, DaedalusSettingKey::AwakeHold, false, open.clone()).await,
            DaedalusSettingAnswer::Sent
        );
        let DaedalusMachine::Ready { settings } = read(&control).await else {
            panic!("expected settings");
        };
        assert_eq!(
            settings.pending,
            [DaedalusSettingPending {
                key: DaedalusSettingKey::AwakeHold,
                want: false,
                via: DaedalusSettingVia::Box,
            }]
        );
        agent.apply(SettingKey::AwakeHold, false);
        let DaedalusMachine::Ready { settings } = read(&control).await else {
            panic!("expected settings");
        };
        assert!(!settings.awake_hold && settings.pending.is_empty());

        // santree ON: nothing sent; its page opened, and pending on the browser.
        let answer = set(&control, DaedalusSettingKey::Santree, true, open.clone()).await;
        let url = format!(
            "{}/settings?tab=machines&node=0123456789abcdef&santree=on",
            FakeAgentControl::APP_URL
        );
        assert_eq!(answer, DaedalusSettingAnswer::Opened { url: url.clone() });
        assert_eq!(*log.lock().unwrap(), [url]);
        let DaedalusMachine::Ready { settings } = read(&control).await else {
            panic!("expected settings");
        };
        assert_eq!(settings.pending[0].via, DaedalusSettingVia::Browser);

        // A failure the box reports is the agent's own words.
        set(
            &control,
            DaedalusSettingKey::ClaudeRemoteControl,
            false,
            open.clone(),
        )
        .await;
        agent.fail(SettingKey::ClaudeRemoteControl, "Daedalus is not listening");
        let DaedalusMachine::Ready { settings } = read(&control).await else {
            panic!("expected settings");
        };
        assert_eq!(
            settings.failed,
            [DaedalusSettingFailed {
                key: DaedalusSettingKey::ClaudeRemoteControl,
                want: false,
                why: "Daedalus is not listening".into(),
            }]
        );

        // Not the operator: read-only, and a set is refused with the reason.
        agent.set_may_change(false);
        let DaedalusMachine::Ready { settings } = read(&control).await else {
            panic!("expected settings");
        };
        assert!(!settings.may_change);
        assert!(matches!(
            set(&control, DaedalusSettingKey::AwakeHold, true, open).await,
            DaedalusSettingAnswer::Refused { reason } if reason.contains("may not change")
        ));
    }

    /// An agent from before 0.25, none at all, and a page that isn't https.
    #[tokio::test]
    async fn an_old_or_missing_agent_and_a_bad_page_are_states() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("agent.sock");
        assert_eq!(
            read(&AgentControl::at(&socket, 0)).await,
            DaedalusMachine::AgentMissing
        );

        let agent = FakeAgentControl::serve(&socket, kept()).unwrap();
        let control = agent.control();
        agent.set_outdated(true);
        assert_eq!(read(&control).await, DaedalusMachine::AgentOutdated);
        let (log, open) = opened();
        assert_eq!(
            set(&control, DaedalusSettingKey::Santree, true, open.clone()).await,
            DaedalusSettingAnswer::AgentOutdated
        );
        agent.set_outdated(false);

        for bad in [
            "http://daedalus.example.test",
            "file:///etc",
            "https://u:p@x.test",
        ] {
            agent.set_app_url(Some(bad));
            let answer = set(&control, DaedalusSettingKey::Santree, true, open.clone()).await;
            assert!(
                matches!(&answer, DaedalusSettingAnswer::Refused { reason } if reason.contains("https")),
                "{bad}: {answer:?}"
            );
        }
        assert!(log.lock().unwrap().is_empty(), "nothing was opened");
    }
}
