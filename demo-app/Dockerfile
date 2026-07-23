FROM python:3.13-slim

WORKDIR /app

COPY requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir -r requirements.txt

COPY server.py init_db.py schema.sql ./
COPY static ./static
COPY tests ./tests

EXPOSE 8080

CMD ["python", "/app/server.py"]
