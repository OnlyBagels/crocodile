# How coordination servers share the work

Until protocol 2, every coordination server linked to every other one and
kept a copy of every record. That is simple and fine for a handful of
servers, but it doesn't grow: links grow with the square of the number of
servers, and every server, including one someone runs from the desktop app,
stores and receives every profile, space and membership of the whole network.

Since protocol 2 the servers form a **sparse overlay** and each record lives on
a **few owner servers**. A small network behaves exactly as before: while the
network has no more servers than a record has owners, every server owns
everything, and while it has few enough servers, every server links to every
other.

## Who is alive

Every server floods a signed **beacon** (its id and a sequence number) through
the overlay every 20 seconds. A server is _live_ while we hold a link to it or
have heard its beacon in the last 70 seconds. The live set is what every
decision below is computed from. Two servers may briefly disagree about it;
they converge within a beacon period, and everything below tolerates that
(writes go to the owners the writer sees, reads ask more than one owner, and
records that end up in the wrong place are moved when the views agree).

A beacon also says whether its server keeps a **full copy** (`--store-all`):
such servers own every record in addition to the owners chosen by hashing, so
the network never depends on a handful of home computers for its data. The
main server runs with it.

## Links

- **Overlay links** stay open. With up to 16 known servers a server links to
  all of them, as before. Beyond that it links to its configured peers, its
  two neighbours on either side of a ring of server ids, and servers at ring
  distances of 1/4, 1/8, … of the way round. Every server has about 4 + log₂ N
  links, and the overlay stays connected as long as the ring does: there is
  no way for a group of servers to drift apart, because their ring
  neighbours are always among their links.
- **Direct links** are opened when a server needs to talk to a specific other
  server (a record's owner, a session's owner, the server a user is on) and
  closed again after five idle minutes. Every listed server is reachable (the
  directory checks), so two servers never depend on a third to talk. A server
  that couldn't be reached three times in a row is skipped for five minutes,
  then tried again.
- **Flooding** carries what every server needs to hear: beacons, presence,
  voice-room occupancy, mailbox and device-link queries. A flooded frame has an
  id and a hop limit; each server forwards a frame it hasn't seen to its other
  overlay links.

## Where records live

Records are placed by a consistent-hash ring with 16 virtual points per live
server. Each record has one or more **shards**, and its owners are the first
`replicas` (3 by default) servers clockwise from each shard's point, plus every
live full-copy server:

| Record                | Shards                           | Checked and counted at |
| --------------------- | -------------------------------- | ---------------------- |
| profile               | `user:<id>`, `name:<lowercase>`  | `user:<id>`            |
| device, friends, note | `user:<id>`                      | `user:<id>`            |
| space                 | `space:<id>`, `user:<owner>`     | `user:<owner>`         |
| invite                | `invite:<code>`, `space:<space>` | `space:<space>`        |
| member                | `space:<space>`, `user:<member>` | `user:<member>`        |

The shards keep every query a client makes on one shard: a user's devices,
notes, memberships and owned spaces are all on `user:<id>`; a space's members
and invites on `space:<id>`; an invite can be looked up by its code; a search
by name goes to `name:<name>`.

- **Writes.** The server a client is connected to sends a new record to the
  owners of its home shard (the last column). The first one that answers
  validates it with the usual rules, including per-account quotas (it holds
  everything the quota counts), stores it and copies it to the other owners.
  Before the write is confirmed, an owner of each of the record's other shards
  holds it too, so a read right after the write finds it wherever it looks
  (a space's member list just after joining, say). Records a check depends on that live elsewhere (the author's profile, a
  space, an invite) are fetched from their owners and kept for a few minutes.
- **Reads.** A server answers from its own store for shards it owns and asks
  the owners otherwise: all of them at once, keeping the newest copy of each
  record, since one owner may not have a record yet that another has. For a
  while after the live set changes, and for a record it lacks, an owner asks
  the other owners too.
- **Live updates.** A server whose clients follow records it doesn't own asks
  the owners to **watch** them for it; owners push each change to the
  watching servers, which pass it on to their clients. Watches last five
  minutes and are renewed.
- **When servers come and go**, the ring changes. Once the live set has been
  stable for a few seconds, each server goes through what it stores and sends
  every record to owners that have just become responsible for it (only the
  first live old owner does, so each record is sent once). Records a server no
  longer owns are deleted after the live set has been stable for ten minutes,
  and only once they have been held long enough to have seen the change that
  made the server an owner: a server linked to one that went away notices at
  once and hands records on, while the others notice only when its beacons stop.
- **Catching up.** When a link comes up, each side streams the records the
  other owns that it wrote since the last time (per-server cursors, as before).
- **Repair.** Every few minutes a server compares what it holds with one other
  live server: both sum (key, version) over the records they both own into 256
  buckets, and for buckets that differ they swap key lists and send each other
  what the other lacks or holds an older version of. Whatever slipped through
  the steps above is fixed this way.

## Everything else

- **Sessions** are owned by one live server chosen by rendezvous hashing, as
  before; members' servers reach it over a direct link. The owner acts on an
  operation only if the sending server has said that member's device is
  connected to it, checks again that the member may be in the session, and
  believes a host hint only if the host it names may be too. A client event
  routed to us is delivered only if it comes from a server that could be
  sending it: a signal from the server the sending device is connected to, a
  session's state or a conversation invitation from the session's owner.
- **Presence and voice occupancy** are flooded, with a sequence number per
  origin server. When an overlay link comes up, a server sends its own users'
  presence, and every room it knows is occupied (and those that emptied in the
  last hour), as they were signed. Each beacon carries its server's latest
  presence sequence number: a server that has seen less missed something, as a
  newcomer has, and fetches that server's full presence directly. Servers
  forget what came from a server that has stopped being live.
  Both are signed by the server they come from (like beacons), with its key in
  the frame. A frame that isn't signed by the server it names is dropped, so
  no server can speak for another. Sequence numbers are timestamps: one dated more than five
  minutes ahead is refused, since it would outrank everything its origin says
  afterwards. Voice-room occupancy is only believed from the server that owns
  the room, and only while recent: the owner repeats it every five minutes, and
  a server ignores announcements older than fifteen.
- **Account deletion.** The deletion marker reaches the owners of the user's
  shard, which erase what they hold and send the marker on to the owners of
  every space the user was a member of, which erase the memberships. They keep
  sending it (across restarts, for up to 30 days) until each of those owners
  has confirmed.

## Limits

- Anyone can run a server, so a server could join only to own a share of the
  records and then not answer for them. It can't change or forge them (they
  are signed), and full-copy servers still hold everything, but deciding who
  may join is a separate, open question.
- Signatures stop one server speaking for another, not a server lying about
  its own users. A server can sign that any user is connected through it, and
  then the events routed to that user (signalling, session invites, mail) go to
  it. That is the same as the server dropping them. Closing it would take the
  user's device proving which server it connected to.
- Every server still hears every beacon and every presence change; that is
  fine for thousands of servers but not for millions of users online at once.
  Presence would then move to the owners of each user's shard.
- The live set is eventually consistent. Right after servers join or leave, a
  read can miss a record written a moment earlier on the other side of the
  change; it shows up once the records have moved.
- Servers on protocol 1 can't join a protocol 2 network (and the other way
  round): update coordination servers together.
