FROM postgres@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722
RUN apt-get update && apt-get install -y --no-install-recommends python3 age ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts/backup.py /app/backup.py
USER postgres
ENTRYPOINT ["timeout", "--signal=TERM", "--kill-after=10s", "600s", "python3", "/app/backup.py"]
