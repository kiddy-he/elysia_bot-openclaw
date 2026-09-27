# OneBot Role Routing

`onebot-role-routing.json` is the registry for role-to-account routing. The gateway does not contain a fixed two-role branch.

## Role entry

Each key under `roles` is a stable role ID. A role entry contains:

- `agentId`: the normal OpenClaw agent with this role's private/group memory.
- `peerAgentId`: a no-tools agent used only for one controlled cross-role follow-up.
- `peerSoulPath`: a public role-summary file injected into peer turns so another role can understand this role's identity and group-chat style without reading private memory.
- `accountId`: the OneBot account that sends this role's messages.
- `displayName`: visible role name.
- `names`: text aliases used to select the role.
- `selfIds`: QQ IDs used for explicit @ selection. Runtime self IDs are also learned from OneBot events.
- `enabled`: optional switch; set to `false` to disable a role without deleting its memory.

## Group entry

`groups` maps a group ID to the role IDs allowed in that group:

```json
{
  "groups": {
    "<group-id>": {
      "roles": ["elysia", "yuexia"]
    }
  }
}
```

An unmentioned ordinary message is first sent to a no-tools peer arbiter, which selects one configured role to answer first. After that first reply is delivered, the gateway may start the bounded peer continuation flow. A role name or @ selects only the named role. Explicitly naming multiple roles selects all of them for independent replies, without automatic peer continuation.

For unassigned ordinary conversation, the gateway first asks a no-tools peer arbiter to choose one initial role. After the initial role's reply is delivered, the gateway may ask the other role for a useful continuation. The peer should judge the actual exchange rather than a fixed topic whitelist or fixed reply count: it may ask or answer questions, follow up, joke, comfort, disagree, argue, clarify, apologize, reconcile, collaborate, change direction, or close naturally when there is no conversational opening. It should stop for repetition, interruption, off-topic content, or operational requests, and must not manufacture conflict merely to keep talking. The peer request includes a typed internal envelope with the original sender type (`admin` or `user`), original user message, source/target role IDs, public role summaries, and the source reply. It starts the turn with a continuation score of 5, decreases the score after each accepted continuation, allows at most one short closing reply when the score reaches zero, and then closes the turn. Backend operations, explicitly selected turns, image workflows, and approval messages never start peer conversation. The envelope and public summaries are internal context and must never be quoted in QQ.

An unassigned group operation is tool-blocked and asks who should execute it. A single explicitly selected role may proceed through the existing approval chain only when the sender is a configured admin. Non-admin group members may chat and generate or edit images, but cannot run backend operations or create approval requests. A cross-role follow-up uses `peerAgentId`, is limited to one per user turn, and has all tools denied.

Before enabling a group, configure its group allowlist on every participating OneBot account and configure the admin ID in `adminIds` or in each account's private allowlist. Group approvals must quote the approval message.
