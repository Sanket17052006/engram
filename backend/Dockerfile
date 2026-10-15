FROM python:3.12-slim
WORKDIR /srv/engram
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY engram_core ./engram_core
ENV PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn", "engram_core.main:app", "--host", "0.0.0.0", "--port", "8000"]
