FROM gcc:14

WORKDIR /app

COPY . .

RUN g++ -std=c++17 -O2 main.cpp -o server -pthread

EXPOSE 10000

CMD ["sh", "-c", "./server ${PORT:-10000} public"]
