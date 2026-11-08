FROM python:3.12-alpine
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY app.py manager.py ./
RUN mkdir /state && chown 65532:65532 /state
USER 65532:65532
EXPOSE 8090
CMD ["python3", "app.py"]
