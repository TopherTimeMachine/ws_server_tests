cmake_minimum_required(VERSION 3.20)
project(speed_test_cpp_server CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
set(CMAKE_CXX_FLAGS_RELEASE "-O3")

if(POLICY CMP0167)
  cmake_policy(SET CMP0167 NEW)
endif()

# Boost.Beast, Asio and JSON are all used header-only.
find_package(Boost 1.80 REQUIRED)
find_package(Threads REQUIRED)

add_executable(speed_server server.cpp)
target_link_libraries(speed_server PRIVATE Boost::headers Threads::Threads)
