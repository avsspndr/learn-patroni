FROM python:3.13-alpine

WORKDIR /app

COPY server.py ./server.py
COPY static ./static

USER nobody

EXPOSE 8080

ENTRYPOINT ["python3", "/app/server.py"]
