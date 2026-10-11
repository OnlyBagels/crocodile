# Main server

One machine runs everything the public Crocodile network needs from "us":

| What                      | Where                                       | Notes                                               |
| ------------------------- | ------------------------------------------- | --------------------------------------------------- |
| Website                   | `https://DOMAIN/`                           | the website, or `placeholder/` until it is deployed |
| Server directory          | `https://DOMAIN/v1/servers`                 | what the apps query to find servers                 |
| One-line installers       | `https://DOMAIN/install.sh`, `/install.ps1` | served from `scripts/`                              |
| First coordination server | `https://coord.DOMAIN`, UDP 7443 and 7444   | STUN, opt-in relay and mailbox on                   |

The directory and coordination server run in Docker
([docker-compose.yml](docker-compose.yml)). HTTPS, the installers and the
website come from the reverse proxy already running on the machine.

## Set up

1. A small VPS (1 vCPU, 1 GB RAM is plenty to start) with Docker and a
   reverse proxy that handles HTTPS.
2. DNS: `A`/`AAAA` records for `DOMAIN` and `coord.DOMAIN` pointing to it.
3. Firewall: TCP 80 and 443 (the proxy), UDP 7443 (STUN and relay), UDP 7444
   (STUN, for NAT detection) and UDP 49160-49259 (relayed traffic, one port
   per relayed connection). Do **not** open TCP 7400 or 7443: those services
   listen on 127.0.0.1 and must only be reached through the proxy. The
   coordinator uses the host's network (see the compose file), so these UDP
   ports are its own.
4. On the server:

   ```sh
   git clone https://github.com/pwalda/crocodile && cd crocodile/deploy/main
   cp .env.example .env   # set CROC_DOMAIN and CROC_RELAY_IP
   docker compose up -d --build
   ```

5. Route these in the reverse proxy (with HTTPS):

   | Request                                   | Goes to                                                                      |
   | ----------------------------------------- | ---------------------------------------------------------------------------- |
   | `DOMAIN/v1/*` and `DOMAIN/health`         | `http://127.0.0.1:7400` (directory)                                          |
   | `DOMAIN/install.sh`, `DOMAIN/install.ps1` | files in `scripts/` of the clone, as `text/plain`                            |
   | everything else on `DOMAIN`               | the website's `public/` folder (`crocodile-website` repo), or `placeholder/` |
   | `coord.DOMAIN` (all paths, WebSocket too) | `http://127.0.0.1:7443` (coordinator)                                        |

   The proxy must add the client's address to `X-Forwarded-For` (appending
   or replacing both work) and be the only hop in front of the coordinator:
   the coordinator takes the last entry, the one the proxy added, for its
   per-address limits.

Check that `https://DOMAIN/v1/servers` lists the coordinator after a minute,
and that `https://coord.DOMAIN/health` answers.

### A reverse proxy running in a container

The coordinator uses the host's network, so it isn't on any Docker network
and a proxy container can't reach it by name (`crocodile-coordinator:7443`)
or at `127.0.0.1` (inside a container, that is the container itself). Have it
listen on the gateway of the proxy's Docker network instead, which the proxy
can reach and the internet can't:

```sh
docker network inspect <proxy-network> --format '{{(index .IPAM.Config 0).Gateway}}'
# e.g. 172.18.0.1: put it in .env
echo 'CROC_COORD_HOST=172.18.0.1' >> .env
docker compose up -d coordinator
```

and route `coord.DOMAIN` to `http://172.18.0.1:7443` (Caddy:
`reverse_proxy 172.18.0.1:7443`). The directory doesn't change: it stays on
the Docker network and the proxy reaches it by name. If the host firewall
(ufw) drops traffic from containers to the host, allow TCP 7443 on that
network's bridge interface (`ip -4 addr` shows which `br-…` has the gateway).

## The default in the apps

Apps built from this repository use `https://crocodilechat.com` as their
server directory (set in `apps/desktop/scripts/build.mjs`). A build can use
other directories by setting `CROC_DIRECTORIES` to a comma-separated list of
URLs (for releases: the repository variable under GitHub → Settings →
Secrets and variables → Actions → Variables), or `none` for no default. Users
can still add other servers under Settings → Network.

## Updating

```sh
git pull && docker compose up -d --build
```

Upgrading from 0.3.x: the coordinator moved from published ports to the
host's network (for the relay's UDP port range). Its WebSocket port is now on
the host's `127.0.0.1:7443`; a proxy in a container needs
[the setting above](#a-reverse-proxy-running-in-a-container), and the
firewall needs UDP 49160-49259 open for the relay.

The placeholder page and install scripts update with `git pull` alone (the
proxy serves them straight from the clone).

## Load and privacy

The directory only sees coordination servers registering and apps fetching
the list. The coordinator sees metadata (who is online, who talks to whom)
but never message or voice content; relayed traffic and mailbox items are
end-to-end encrypted. Relay users are capped (`CROC_RELAY_MAX_USERS`) and
mailbox items expire after `CROC_MAILBOX_DAYS` (max 7).
