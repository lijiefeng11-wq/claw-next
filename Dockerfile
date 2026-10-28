FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY LICENSE /app/LICENSE
COPY backend /app/backend
RUN mkdir -p /app/var && chown -R 10001:10001 /app
USER 10001:10001
EXPOSE 18880
CMD ["python", "-m", "backend", "serve", "--config", "/run/secrets/claw-next.json", "--data-dir", "/app/var", "--host", "0.0.0.0", "--allow-remote"]
