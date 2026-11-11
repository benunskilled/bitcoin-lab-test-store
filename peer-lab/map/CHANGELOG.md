# Changelog

The release notes of every Peer Map version published on GitHub, newest first, as on the [releases page](https://github.com/benunskilled/peer-map/releases). GitHub releases start at 0.3.0.

## 2.8.0 – 2026-11-11

On a phone the block route is now a timeline with each stretch's time on the right. The hop into your node is counted as BIP152 does: half a ping from a high-bandwidth peer (⚡), more when the block was announced first, and at least one more when your node had to ask for missing transactions; this needs Bitcoin Lab 2.6.0. On a wide screen every peer has one grey line under its kind, such as which wallet it probably is. Bitflash, 21 Data Lab's crawler and Nebula are recognised.

## 2.7.0 – 2026-11-08

The block card has one switch, This block or Typical (the last 100 blocks), for both the route and the compact-block line; this needs Bitcoin Lab 2.5.0. The block line names the pool in full, without "mined by". Every peer not on your chain, altcoins and Knots forks alike, gets one "other chain" chip, and filtered lists drop label lines that only repeat what's already shown.

## 2.6.0 – 2026-11-07

The block card shows how your node rebuilt the block: from its mempool, after asking for missing transactions, with how much of the block that was, or downloaded whole. Switch to 24 hours or 7 days for the averages; this needs Bitcoin Lab 2.4.0. Pool nodes say whose block relay they are, a disguised peer only reads as a crawler when it asks for many addresses, and more clients are recognised.

## 2.5.2 – 2026-11-06

The block wave runs evenly across the page, as in Bitcoin Lab. A peer with a name Peer Map doesn't know is described by what it did before it is guessed to be a full node, so one that only takes transactions no longer reads as a node.

## 2.5.1 – 2026-11-05

A tap on a version, name or label chip in the kind filter works again. In 2.5.0 the pick was undone straight away.

## 2.5.0 – 2026-11-05

The kind filter is grouped into five families, with chips for Knots versions and for labels several nodes share, such as FutureBit Apollo. Nodes set up with Samourai Dojo, RoninDojo, MiniBolt or Apollo say so, and more clients are recognised. Stricter disguise rules keep real nodes from being flagged. Your outbound and manual peers sit in front on the map, phones get a legend and a cleaner block route, and a tap on anything open folds it shut. Pages load faster.

## 2.4.0 – 2026-11-02

Pool nodes now name their pool for 39 pools, up from 7. ViaBTC's relay software, found by 0xB10C, reads as a pool node instead of Disguised, and known block relays say so under their label. Tables no longer run past their card.

## 2.3.0 – 2026-10-30

Peer Map no longer accepts Multipath TCP connections. ⚡ and 📡 show which peers may send you new blocks unasked and which ones your node sends them to. Ping shows the lowest ping, and a peer's detail splits its traffic by message type.

## 2.2.0 – 2026-10-29

A grey line under each label says what sets a peer apart: why it is disguised, what an unknown program does, pruned, another chain, a pool or syncing. Cards fold to their title, the page holds your place while tables refresh, and every kind has a filter level for versions and names. Bitcoin Purity is flagged as another chain, and more clients are recognised.

## 2.1.0 – 2026-10-27

Tap or click a peer to see everything known about it: what it is, why each flag is there, its connection and traffic. Pool nodes name their pool where the address proves it, and you can pick a single pool under Pool node. Lightning wallets show which lnd they run. Syncing peers are marked and can be filtered, and with a group picked the list says in a line or two why each peer is in it. A reload keeps your place, and the map no longer jumps while loading.

## 2.0.4 – 2026-10-25

Peers on another chain are flagged: nodes that set Knots' BIP110 or BLAKE2b bit can never bring you a block. Peers coming through a Tor exit are marked, since their place is the exit's. Peer Map now recognises Wasabi and Ginger behind their borrowed Core names, Libre Relay, Lightning wallets and many more clients. Hover over "no tx" to see why a peer wants no transactions. The three tables line up, and on phones the label sits next to the place.

## 2.0.3 – 2026-10-22

Disguised now also looks at behaviour: a peer naming Bitcoin Core or Knots that asks for addresses again and again, or pings more often than every 5 seconds, is flagged. A Bitcoin Wallet peer speaking a newer protocol than the app ever did now says "not a wallet". Long provider names on phones end with "…".

## 2.0.2 – 2026-10-20

ckp2p is a pool node again: it is ckpool's block relay. ckcoind is listed as a pool node and dnsseed-rust as a crawler. Disguised now also catches peers whose protocol version doesn't match the Core release they name, which finds LinkingLion outside its known address ranges too, and Core peers since 0.16 that lack the pruned-node service. Built with Go 1.27.3.

## 2.0.1 – 2026-10-18

Inbound shows its top ten, with "Show all". Tables now fit narrower windows and phones.

## 2.0.0 – 2026-10-17

Peer Map 2.0.0 has a new design: a dot map with lit markers, arcs to your node and a pulse when a block arrives, and tables that turn into cards on narrow screens. LinkingLion peers get their own red pill, whatever software they claim. On Umbrel, Tor and I2P peers are shown as hidden with 🧅 and 🌐, and peers from your own Umbrel, such as its indexers, are named after their app with 🏠. Peers that have delivered a block first show their address in green, and the groups are ordered inbound, outbound, manual everywhere. Links between Peer Map and Bitcoin Lab reuse one window per app; on phones they open in the same tab.

## 1.0.0 – 2026-10-12

The header now counts LinkingLion connections on their own, with a link explaining who they are. Peer Map now recognises LinkingLion by the ranges in the bnoc banlist, including two single addresses it missed: on my node one of them alone had opened 5,822 connections under 82 fake wallet names. Peers whose user agent contains /mempool count as indexers again. Locations and network names now come from October's DB-IP data.

## 0.9.6 – 2026-10-09

"Fake" is now called "Disguised", and it now also catches peers that call themselves Bitcoin Core but offer nothing – real Core always offers at least blocks. ckp2p is no longer listed as a pool node, a "(mempool…)" label no longer makes a node a pool or an indexer, and NBitcoin and Bitcore get a short description. On Umbrel, inbound IPv6 peers now show as "IPv6 (address hidden)" instead of "Private": umbrelOS hands them over through Docker, which hides their real address.

## 0.9.5 – 2026-10-07

Peer Map now names LinkingLion. Peers from the address ranges that 0xB10C tracks as LinkingLion – an entity that connects to many nodes and may link transactions to their IP addresses – are still listed as Fake, and their description now says who they probably are. Connections without a user agent from these ranges are recognised too.

## 0.9.4 – 2026-10-07

Peer Map 0.9.4 is a maintenance release. It is built with Go 1.27, with the build image pinned, and when Bitcoin Lab's block information is too large to read it now says so in its log instead of quietly dropping the block card. Bitcoin Lab 1.25.8 keeps that reply small, so update both.

## 0.9.3 – 2026-09-30

**See how spread out your peers are.** Each group now counts its providers and countries, so you can tell at a glance whether your manual peers sit with one host or many. Struck through now means the same for every kind: this peer cannot deliver a block first.

## 0.9.2 – 2026-09-27

**See who your peers really are.** Filtering by a kind now says why, and shows each peer's user agent and what that software is. A new Fake kind catches peers pretending to be something else - like an old Core version offering what it never had - and says what they claim and what they probably are. More crawlers and node software are recognised, and the header counts how many peers are fake or crawling.

## 0.9.1 – 2026-09-26

The route card keeps the transaction count when your pool's job is ready the same moment as the template.

## 0.9.0 – 2026-09-25

**See why a job took longer.** Next to the time your pool needed to build its job, the route now shows how many transactions the block template carried. The bigger the template, the longer the job takes. This needs Bitcoin Lab 1.24.0. With an older version the route looks as before.

A node that names a pool in its user agent, such as "(PyBLOCK-POOL)", now shows as a pool node. A lost connection to Core reads as a short sentence instead of a raw error with your node's address, and closing a browser tab no longer leaves the map showing an error for a few seconds.

## 0.8.0 – 2026-09-22

**Green rows** in the peer tables are the connections Bitcoin Lab has seen

deliver a block first at least once. On one real node that is about one in

twelve connected peers — every manual peer and a handful of inbound ones. The

peer that brought the newest block is **orange** for as long as its star is

up, two minutes, and then turns green.

The route of a block reads better when your peer had the block before any

pool sent a job. The first job is the zero the times are counted from, not a

stop the block passes, so it no longer cuts the ping into two unlabelled

pieces.

Green and orange rows need Bitcoin Lab 1.23.0.

## 0.7.0 – 2026-09-21

The route of a block now has **four stretches**, each with its own lever: the

block reaching your peer, the hop into your node, Core building the next

template, and your pool turning it into a job. Where the time goes is where

you can make it shorter.

Beside this block's route there is the **typical block**: every stop at its

median over the last hundred blocks. One block scatters; the median shows

whether a change made anything shorter. Switch between the two above the

route — the choice is remembered.

The template stop needs Bitcoin Lab 1.22.0. With an older Bitcoin Lab the card

is as it was.

## 0.6.0 – 2026-09-21

The block card now draws the **route of the newest block**, to scale. It

starts at the first new job any pool sent here — the zero, because when a

block was found cannot be measured — and runs through the peer that delivered

it, with its location and hosting provider, to your node and on to your own

pool's job. The long stretch is the long stretch: you see at a glance where

the time goes.

Everything on it is measured by one clock on one machine, except the hop from

the peer into your node, which is estimated from that peer's lowest ping. Core

sometimes has a block before any pool has sent a job; the route shows that

too, left of the zero.

With Stratum Race running, the summary and the route stay open and only the

full pool list folds away. On a phone the route becomes a list. Nothing new is

asked of Bitcoin Lab — it already sends the two timestamps this needs.

## 0.5.0 – 2026-09-20

With **Bitcoin Lab** installed on the same node, a card above the map follows

the newest block: which pool mined it, which of your peers delivered it first,

and — with Stratum Race running — how quickly each pool turned it into fresh

work. Open the card and every delivering peer stands there with its location

and hosting provider, and the race order with your own pool marked.

The peer that brought the block in **is starred on the map** for two minutes,

and in its row in the table, so you can see where your blocks arrive from

before the next one lands. The pool's name sits next to the star in the header.

Missing data stays visible rather than hidden: a miner nobody can name shows

the text out of his own coinbase, a peer that has since disconnected keeps its

row and says so, and a block with no race recorded says why. Several peers

credited for one block are all shown, because the block did not arrive once.

**The counts in each software line are buttons now.** "125 Node (Core) · 14

Other": click one and the tables and the map show only those peers. Finding the

five pool nodes among two hundred connections stopped being a search.

Nothing new is polled for any of this. The block rides along with the peer list

that is fetched every ten seconds anyway, and without Bitcoin Lab the card is

simply not there.

## 0.4.0 – 2026-09-17

The map answers where a peer is. The new **Operator** column answers whose machine it is: the network that announces the address, with the AS number in the cell's title, right next to the location. Sorting by it is the whole point — three peers in three countries at the same company stop looking like diversity the moment they line up under one name. On one real node, three of eight manual peers sat in three different /16 networks and at one provider; only the AS number showed it.

The **Kind** column answers the question somebody actually has: "Node (Core)" and "Node (Knots)" instead of the bare program name, and everything that cannot pass a block on — wallets, light clients, indexers, crawlers, clients of other chains — is struck through. The client string moved into that cell's title, which is what lets all three tables fit on a screen again without scrolling sideways.

If **Bitcoin Lab** is installed on the same node, the header links to it and every address becomes a jump to that peer there — which of them actually delivers each new block first. Both apps share one palette now: manual blue, inbound yellow, outbound sea green, in both windows.

Both embedded tables were rebuilt from their project's corrected source, after its maintainer warned that the npm copies carry errors. Locations now come from a database built in August and September rather than June, networks from one built the day before this release: 81,763 networks, 479,138 IPv4 and 128,248 IPv6 ranges. A lookup takes about 30 ns and allocates nothing, and as before nothing is fetched from the internet and no peer address leaves your node.

## 0.3.0 – 2026-09-17

Every peer now says what kind of software it is — Core, Knots, a wallet, a light client, an indexer, a crawler, a research scanner, a mining pool, a client of another chain — with the mix summarised under each heading.

How much that is worth is a fair question, because the name comes from the peer itself and it can put anything there. On the node this app was built for, four connections called themselves Bitcoin Core with a zero in place of the o. So three things Bitcoin Core observed sit next to the name, and none of them can be typed into a string: whether the peer offers any services at all, whether it asked for transactions, and whether Core has ever learned which chain it is on. A peer claiming to be Bitcoin Core while offering nothing and having no known chain is worth a second look.

Nothing is downloaded for this and the app is no larger — the name was already in every row, it just was not read. The demo data now shows the mix of a real node instead of six versions of Core.

**Image:** `ghcr.io/benunskilled/peer-map:0.3.0`

**Digest:** `sha256:18438fb8b155c7251b284231a6814b23db82fcf8978aa30498b3de9ac591b7cb`
