# Use Debian as base image
FROM debian:trixie-slim

# Install dependencies
RUN apt-get update -y && apt-get install -y postgresql-common ca-certificates python3-pip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install PostgreSQL repository, PostgreSQL 18, and Python dependencies
RUN sh /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
    && apt-get install -y postgresql-18 python3-pip && apt-get clean  && rm -rf /var/lib/apt/lists/*

# Install Patroni with dependencies
RUN python3 -m pip install --break-system-packages --no-cache-dir patroni[etcd3,psycopg3]

# Prepare directories for PostgreSQL data and runtime files, and set ownership to the postgres user
RUN install -d -o postgres -g postgres -m 700 /var/lib/postgresql/data \
    && install -d -o postgres -g postgres -m 775 /var/run/postgresql

# Run Patroni as the postgres user
USER postgres

# Run Patroni with the specified configuration file
ENTRYPOINT ["/usr/local/bin/patroni", "/etc/patroni/config.yml"]