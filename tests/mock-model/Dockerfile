# The mock upstream of the test. Test only, never pushed.
FROM docker.io/library/python:3.15.2-slim-trixie@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928
COPY mock.py /mock.py
ENV MOCK_HOST=0.0.0.0 PYTHONUNBUFFERED=1
USER 65532:65532
EXPOSE 8000
CMD ["python3", "-I", "/mock.py", "8000"]
