FROM python:3.12-alpine
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY app.py manager.py ./
RUN mkdir -m 0700 /state
EXPOSE 8090
CMD ["python3", "app.py"]
